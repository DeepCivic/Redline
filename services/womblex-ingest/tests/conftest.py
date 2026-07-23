"""Shared pytest fixtures: fakes for the object-storage and womblex seams."""

from __future__ import annotations

from typing import Dict, List

import pytest
from fastapi.testclient import TestClient

from womblex_ingest.extraction import ExtractionResult, Shard
from womblex_ingest.main import build_app
from womblex_ingest.storage import ObjectStorage


class FakeObjectStorage(ObjectStorage):
    """In-memory stand-in for the MinIO/S3 writer.

    Records every put so tests can assert the key layout (proc/{evaluationId}/...)
    without a live bucket.
    """

    def __init__(self) -> None:
        self.objects: Dict[str, bytes] = {}

    def put_object(self, key: str, body: bytes, content_type: str) -> None:
        self.objects[key] = body

    def keys_under(self, prefix: str) -> List[str]:
        return sorted(key for key in self.objects if key.startswith(prefix))


class StubExtractor:
    """Deterministic womblex stand-in.

    Emits one manifest shard plus one elements shard per document, so tests can
    assert shard fan-out and provenance without running real womblex/Isaacus.
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
        for name in document_names:
            shards.append(
                Shard(
                    filename=f"{name}.elements.parquet",
                    body=f"elements:{name}".encode(),
                    content_type="application/octet-stream",
                )
            )
        return ExtractionResult(document_count=len(document_names), shards=shards)


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
