"""Shared pytest fixtures: fakes for the object-storage and womblex seams."""

from __future__ import annotations

from typing import Dict, List

import pytest
from fastapi.testclient import TestClient

from womblex_ingest.extraction import ExtractionResult, Shard
from womblex_ingest.main import build_app
from womblex_ingest.records import (
    ChunkRecord,
    DocumentExtraction,
    ElementRecord,
    TableCellRecord,
)
from womblex_ingest.storage import ObjectNotFound, ObjectStorage


class FakeObjectStorage(ObjectStorage):
    """In-memory stand-in for the MinIO/S3 writer.

    Records every put so tests can assert the key layout (proc/{evaluationId}/...)
    without a live bucket, and serves them back via `get_object` so the JSON read
    seam is exercisable end-to-end.
    """

    def __init__(self) -> None:
        self.objects: Dict[str, bytes] = {}

    def put_object(self, key: str, body: bytes, content_type: str) -> None:
        self.objects[key] = body

    def get_object(self, key: str) -> bytes:
        try:
            return self.objects[key]
        except KeyError as error:
            raise ObjectNotFound(key) from error

    def keys_under(self, prefix: str) -> List[str]:
        return sorted(key for key in self.objects if key.startswith(prefix))


class StubExtractor:
    """Deterministic womblex stand-in.

    Emits one manifest shard plus one elements shard per document, and a JSON
    read model per document (documentId = the document name, for readable test
    assertions), so tests can assert shard fan-out, provenance, and the JSON
    read seam without running real womblex/Isaacus.
    """

    def __init__(self) -> None:
        self.calls: List[tuple[str, tuple[str, ...]]] = []

    def extract(self, evaluation_id: str, document_names: List[str]) -> ExtractionResult:
        self.calls.append((evaluation_id, tuple(document_names)))
        shards: List[Shard] = [
            Shard(
                filename="_manifest.parquet",
                body=b"manifest",
                content_type="application/octet-stream",
            )
        ]
        documents: List[DocumentExtraction] = []
        for name in document_names:
            shards.append(
                Shard(
                    filename=f"{name}.elements.parquet",
                    body=f"elements:{name}".encode(),
                    content_type="application/octet-stream",
                )
            )
            documents.append(
                DocumentExtraction(
                    documentId=name,
                    elements=[
                        ElementRecord(
                            documentId=name, elementOrder=0, page=1, text=f"{name} text"
                        )
                    ],
                    chunks=[
                        ChunkRecord(chunkId=f"{name}:0", documentId=name, text="chunk")
                    ],
                    tableCells=[
                        TableCellRecord(
                            documentId=name,
                            elementOrder=1,
                            page=1,
                            rowIndex=0,
                            columnIndex=1,
                            rawValue="80000",
                            isCurrency=True,
                        )
                    ],
                )
            )
        return ExtractionResult(
            document_count=len(document_names), shards=shards, documents=documents
        )


@pytest.fixture()
def storage() -> FakeObjectStorage:
    return FakeObjectStorage()


@pytest.fixture()
def extractor() -> StubExtractor:
    return StubExtractor()


@pytest.fixture()
def client(storage: FakeObjectStorage, extractor: StubExtractor) -> TestClient:
    app = build_app(storage=storage, extractor=extractor, bucket="redline")
    return TestClient(app)
