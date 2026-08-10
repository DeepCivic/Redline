"""The embeddings read seam — Thread 19's exit test (ADR-0014).

Exit criterion: *"pytest reads real vectors for a document, joinable on
`(source_hash, chunk_index)`; absent shard → `NOT_FOUND`."*

`chunkId` is `"{source_hash}:{chunk_index}"` — the join key the extraction seam
already speaks — and `chunkIndex` carries the ordinal explicitly, so a consumer
can join on either without re-parsing a string.
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from tests.conftest import FakeObjectStorage, StubExtractor
from womblex_ingest.extraction import ExtractionResult
from womblex_ingest.main import build_app


def test_ingest_writes_an_embeddings_read_model_beside_the_shards(
    client: TestClient, storage: FakeObjectStorage
) -> None:
    client.post(
        "/ingest",
        json={"evaluationId": "eval-7", "documentNames": ["tender.pdf"]},
    )

    assert "proc/eval-7/tender.pdf.embeddings.json" in storage.objects


def test_read_embeddings_serves_vectors_for_a_document(client: TestClient) -> None:
    client.post(
        "/ingest",
        json={"evaluationId": "eval-9", "documentNames": ["tender.pdf"]},
    )

    response = client.get("/embeddings/eval-9/tender.pdf")

    assert response.status_code == 200
    body = response.json()
    assert body["documentId"] == "tender.pdf"
    assert len(body["vectors"]) == 1
    assert len(body["vectors"][0]["values"]) == body["dimensions"]


def test_read_embeddings_declares_the_producing_model(client: TestClient) -> None:
    # Vectors from different models are incomparable: a consumer matching topic
    # definitions must embed them in this same space or refuse.
    client.post("/ingest", json={"evaluationId": "eval-9", "documentNames": ["a.pdf"]})

    body = client.get("/embeddings/eval-9/a.pdf").json()

    assert body["model"] == "stub-deterministic-v1"
    assert body["dimensions"] == 8


def test_vectors_cross_the_boundary_l2_normalised(client: TestClient) -> None:
    client.post("/ingest", json={"evaluationId": "eval-9", "documentNames": ["a.pdf"]})

    body = client.get("/embeddings/eval-9/a.pdf").json()

    for vector in body["vectors"]:
        magnitude = math.sqrt(sum(value * value for value in vector["values"]))
        assert magnitude == pytest.approx(1.0)


def test_embeddings_join_the_extraction_chunks_on_source_hash_and_chunk_index(
    client: TestClient,
) -> None:
    client.post(
        "/ingest",
        json={"evaluationId": "eval-9", "documentNames": ["tender.pdf"]},
    )

    extraction = client.get("/extractions/eval-9/tender.pdf").json()
    embeddings = client.get("/embeddings/eval-9/tender.pdf").json()

    assert embeddings["documentId"] == extraction["documentId"]
    chunk_ids = [chunk["chunkId"] for chunk in extraction["chunks"]]
    assert [vector["chunkId"] for vector in embeddings["vectors"]] == chunk_ids
    # The composite key decomposes into the pair womblex joins on.
    for vector in embeddings["vectors"]:
        source_hash, chunk_index = vector["chunkId"].rsplit(":", 1)
        assert source_hash == embeddings["documentId"]
        assert int(chunk_index) == vector["chunkIndex"]


def test_read_embeddings_of_unknown_document_is_404(client: TestClient) -> None:
    response = client.get("/embeddings/eval-9/missing.pdf")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_embeddings_are_absent_independently_of_the_extraction(
    storage: FakeObjectStorage,
) -> None:
    """A document may have an extraction and no embeddings.

    The embed stage is an optional overlay — it may not have run, or the
    deployment may be air-gapped. The extraction must keep serving while the
    embeddings resource reports NOT_FOUND (ADR-0014).
    """

    class ExtractorWithoutEmbedStage(StubExtractor):
        def extract(self, evaluation_id, document_names, run_id=None):  # type: ignore[override]
            result = super().extract(evaluation_id, document_names, run_id)
            return ExtractionResult(
                document_count=result.document_count,
                shards=result.shards,
                documents=result.documents,
                embeddings=[],
            )

    client = TestClient(
        build_app(storage=storage, extractor=ExtractorWithoutEmbedStage(), bucket="redline")
    )
    client.post("/ingest", json={"evaluationId": "eval-1", "documentNames": ["a.pdf"]})

    assert client.get("/extractions/eval-1/a.pdf").status_code == 200
    embeddings = client.get("/embeddings/eval-1/a.pdf")
    assert embeddings.status_code == 404
    assert embeddings.json()["error"]["code"] == "NOT_FOUND"


def test_embeddings_are_isolated_per_evaluation(
    client: TestClient, storage: FakeObjectStorage
) -> None:
    client.post("/ingest", json={"evaluationId": "eval-a", "documentNames": ["x.pdf"]})
    client.post("/ingest", json={"evaluationId": "eval-b", "documentNames": ["y.pdf"]})

    assert client.get("/embeddings/eval-a/y.pdf").status_code == 404
    assert client.get("/embeddings/eval-b/y.pdf").status_code == 200
