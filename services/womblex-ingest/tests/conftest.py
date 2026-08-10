"""Shared pytest fixtures: fakes for the object-storage and womblex seams."""

from __future__ import annotations

from typing import Dict, List, Sequence

import pytest
from fastapi.testclient import TestClient

from womblex_ingest.extraction import (
    STUB_EMBEDDING_DIMENSIONS,
    STUB_EMBEDDING_MODEL,
    ExtractionResult,
    Shard,
)
from womblex_ingest.main import build_app
from womblex_ingest.records import (
    ChunkRecord,
    DocumentEmbeddings,
    DocumentExtraction,
    ElementRecord,
    EmbeddingRecord,
    TableCellRecord,
    make_document_embeddings,
)
from womblex_ingest.money_span_store import MoneySpanRow
from womblex_ingest.storage import ObjectNotFound, ObjectStorage


class RecordingMoneySpanStore:
    """In-memory `MoneySpanStore`, scoped the way the Postgres one is.

    Exposes the landed rows directly so the load path's exit test can assert them
    field by field against the shard, and counts the replaces so a re-load can be
    told from a duplicate insert.
    """

    def __init__(self) -> None:
        self.spans: Dict[str, List[MoneySpanRow]] = {}
        self.replace_calls = 0

    def replace_evaluation_spans(
        self, evaluation_id: str, rows: Sequence[MoneySpanRow]
    ) -> None:
        self.replace_calls += 1
        self.spans[evaluation_id] = list(rows)

    def for_document(self, evaluation_id: str, document_id: str) -> List[MoneySpanRow]:
        return [
            row
            for row in self.spans.get(evaluation_id, [])
            if row.document_id == document_id
        ]


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

    def list_objects(self, prefix: str) -> List[str]:
        return self.keys_under(prefix)


class StubExtractor:
    """Deterministic womblex stand-in.

    Emits one manifest shard plus one elements shard per document, a JSON read
    model per document (documentId = the document name, for readable test
    assertions), and its embeddings sibling, so tests can assert shard fan-out,
    provenance, and both read seams without running real womblex/Isaacus.
    """

    def __init__(self) -> None:
        self.calls: List[tuple[str, tuple[str, ...]]] = []
        self.run_ids: List[object] = []

    def extract(
        self,
        evaluation_id: str,
        document_names: List[str],
        run_id=None,
    ) -> ExtractionResult:
        self.calls.append((evaluation_id, tuple(document_names)))
        self.run_ids.append(run_id)
        embeddings: List[DocumentEmbeddings] = []
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
            embeddings.append(
                make_document_embeddings(
                    document_id=name,
                    model=STUB_EMBEDDING_MODEL,
                    vectors=[
                        EmbeddingRecord(
                            chunkId=f"{name}:0",
                            chunkIndex=0,
                            values=[
                                float(index + 1)
                                for index in range(STUB_EMBEDDING_DIMENSIONS)
                            ],
                        )
                    ],
                )
            )
        return ExtractionResult(
            document_count=len(document_names),
            shards=shards,
            documents=documents,
            embeddings=embeddings,
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
