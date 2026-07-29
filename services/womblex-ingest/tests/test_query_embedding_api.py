"""The text-embedding query seam — Thread 20a's exit test (ADR-0014).

Thread 19 ships one vector per *chunk*. Retrieval also needs the
*topic definition* embedded in the same space to match against those chunks, and
redline's TypeScript has no embedding model — so the sidecar owns query embedding
too, exactly as it owns chunk embedding.

Exit criterion: *"pytest embeds text and gets a vector whose `model` and
`dimensions` match the document embeddings' declaration; the same text embeds
identically twice."*
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from tests.conftest import FakeObjectStorage
from womblex_ingest.extraction import STUB_EMBEDDING_DIMENSIONS, STUB_EMBEDDING_MODEL


def test_query_embedding_returns_a_vector(client: TestClient) -> None:
    response = client.post("/embeddings/query", json={"text": "network security controls"})

    assert response.status_code == 200
    body = response.json()
    assert len(body["values"]) == body["dimensions"]


def test_query_embedding_declares_the_same_model_as_document_vectors(
    client: TestClient,
) -> None:
    # The whole point of the query seam: a topic definition must be embedded in
    # the *same* space as the chunk vectors, or nearest-neighbour ranks noise.
    client.post("/ingest", json={"evaluationId": "eval-9", "documentNames": ["a.pdf"]})
    document = client.get("/embeddings/eval-9/a.pdf").json()

    query = client.post("/embeddings/query", json={"text": "some topic definition"}).json()

    assert query["model"] == document["model"]
    assert query["dimensions"] == document["dimensions"]
    assert query["model"] == STUB_EMBEDDING_MODEL
    assert query["dimensions"] == STUB_EMBEDDING_DIMENSIONS


def test_the_same_text_embeds_identically_twice(client: TestClient) -> None:
    first = client.post("/embeddings/query", json={"text": "identical text"}).json()
    second = client.post("/embeddings/query", json={"text": "identical text"}).json()

    assert first == second


def test_different_text_embeds_differently(client: TestClient) -> None:
    first = client.post("/embeddings/query", json={"text": "security"}).json()
    second = client.post("/embeddings/query", json={"text": "warranty"}).json()

    assert first["values"] != second["values"]


def test_query_vector_crosses_the_boundary_l2_normalised(client: TestClient) -> None:
    # Cosine similarity against the (already unit-norm) chunk vectors becomes a
    # dot product only if the query vector is unit-norm too (ADR-0014).
    body = client.post("/embeddings/query", json={"text": "anything"}).json()

    magnitude = math.sqrt(sum(value * value for value in body["values"]))
    assert magnitude == pytest.approx(1.0)


def test_query_vector_lives_in_the_same_space_as_the_chunk_vectors(
    client: TestClient,
) -> None:
    # Same dimensionality end to end, so a dot product between a query and a
    # chunk vector is well-formed.
    client.post("/ingest", json={"evaluationId": "eval-9", "documentNames": ["a.pdf"]})
    chunk = client.get("/embeddings/eval-9/a.pdf").json()["vectors"][0]

    query = client.post("/embeddings/query", json={"text": "topic"}).json()

    assert len(query["values"]) == len(chunk["values"])


def test_blank_text_is_rejected(client: TestClient) -> None:
    response = client.post("/embeddings/query", json={"text": "   "})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_missing_text_field_is_rejected(client: TestClient) -> None:
    response = client.post("/embeddings/query", json={})

    assert response.status_code == 422


def test_query_embedding_needs_no_prior_ingest(
    storage: FakeObjectStorage,
) -> None:
    # The query seam is independent of any evaluation's shards — a topic
    # definition is embedded before a corpus is even mapped.
    from tests.conftest import StubExtractor
    from womblex_ingest.main import build_app

    client = TestClient(
        build_app(storage=storage, extractor=StubExtractor(), bucket="redline")
    )

    response = client.post("/embeddings/query", json={"text": "topic"})

    assert response.status_code == 200
