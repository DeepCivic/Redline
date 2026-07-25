"""The embedding wire model's construction guarantees (ADR-0014).

`make_document_embeddings` is the only way to build the payload, so the
boundary's promises — unit-norm vectors, a truthful `dimensions`, a usable join
key — hold by construction rather than by convention.
"""

from __future__ import annotations

import math

import pytest

from womblex_ingest.records import EmbeddingRecord, make_document_embeddings


def magnitude(values: list[float]) -> float:
    return math.sqrt(sum(value * value for value in values))


def test_vectors_cross_l2_normalised() -> None:
    embeddings = make_document_embeddings(
        document_id="doc-1",
        model="stub-deterministic-v1",
        vectors=[EmbeddingRecord(chunkId="doc-1:0", chunkIndex=0, values=[3.0, 4.0])],
    )

    assert magnitude(embeddings.vectors[0].values) == pytest.approx(1.0)
    assert embeddings.vectors[0].values == pytest.approx([0.6, 0.8])


def test_dimensions_are_derived_from_the_vectors() -> None:
    embeddings = make_document_embeddings(
        document_id="doc-1",
        model="stub-deterministic-v1",
        vectors=[
            EmbeddingRecord(chunkId="doc-1:0", chunkIndex=0, values=[1.0, 0.0, 0.0]),
            EmbeddingRecord(chunkId="doc-1:1", chunkIndex=1, values=[0.0, 1.0, 0.0]),
        ],
    )

    assert embeddings.dimensions == 3


def test_the_join_key_and_ordinal_survive_construction() -> None:
    embeddings = make_document_embeddings(
        document_id="abc123",
        model="stub-deterministic-v1",
        vectors=[EmbeddingRecord(chunkId="abc123:7", chunkIndex=7, values=[1.0, 1.0])],
    )

    assert embeddings.documentId == "abc123"
    assert embeddings.vectors[0].chunkId == "abc123:7"
    assert embeddings.vectors[0].chunkIndex == 7


def test_ragged_vectors_are_rejected() -> None:
    with pytest.raises(ValueError, match="same number of dimensions"):
        make_document_embeddings(
            document_id="doc-1",
            model="stub-deterministic-v1",
            vectors=[
                EmbeddingRecord(chunkId="doc-1:0", chunkIndex=0, values=[1.0, 0.0]),
                EmbeddingRecord(chunkId="doc-1:1", chunkIndex=1, values=[1.0, 0.0, 0.0]),
            ],
        )


def test_a_zero_vector_is_rejected() -> None:
    with pytest.raises(ValueError, match="zero-magnitude"):
        make_document_embeddings(
            document_id="doc-1",
            model="stub-deterministic-v1",
            vectors=[EmbeddingRecord(chunkId="doc-1:0", chunkIndex=0, values=[0.0, 0.0])],
        )


def test_duplicate_chunk_ids_are_rejected() -> None:
    with pytest.raises(ValueError, match="one vector per chunk"):
        make_document_embeddings(
            document_id="doc-1",
            model="stub-deterministic-v1",
            vectors=[
                EmbeddingRecord(chunkId="doc-1:0", chunkIndex=0, values=[1.0, 0.0]),
                EmbeddingRecord(chunkId="doc-1:0", chunkIndex=0, values=[0.0, 1.0]),
            ],
        )


def test_a_document_with_no_vectors_is_rejected() -> None:
    # A document that produced no chunks has no embeddings shard at all — the
    # NOT_FOUND path. Serving an empty payload instead would hide that.
    with pytest.raises(ValueError, match="at least one vector"):
        make_document_embeddings(
            document_id="doc-1", model="stub-deterministic-v1", vectors=[]
        )


def test_an_empty_model_id_is_rejected() -> None:
    # Vectors from different models are incomparable, so an undeclared model
    # makes the payload unusable to a consumer that must match the same space.
    with pytest.raises(ValueError, match="model"):
        make_document_embeddings(
            document_id="doc-1",
            model="  ",
            vectors=[EmbeddingRecord(chunkId="doc-1:0", chunkIndex=0, values=[1.0])],
        )


def test_to_json_is_the_wire_shape() -> None:
    embeddings = make_document_embeddings(
        document_id="doc-1",
        model="stub-deterministic-v1",
        vectors=[EmbeddingRecord(chunkId="doc-1:0", chunkIndex=0, values=[3.0, 4.0])],
    )

    assert embeddings.to_json() == {
        "documentId": "doc-1",
        "model": "stub-deterministic-v1",
        "dimensions": 2,
        "vectors": [{"chunkId": "doc-1:0", "chunkIndex": 0, "values": [0.6, 0.8]}],
    }
