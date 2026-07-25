"""The stub text embedder and the query wire model (Thread 20a, ADR-0014).

`StubTextEmbedder` embeds arbitrary text into the *same* space the stub's chunk
vectors live in (same model id, same dimensions), deterministically, so a
captured fixture is stable and Thread 22's nearest-neighbour is well-formed.
`make_query_embedding` is the only constructor for the wire model, so the
boundary's promises (unit-norm, truthful `dimensions`) hold by construction.
"""

from __future__ import annotations

import math

import pytest

from womblex_ingest.embedding import StubTextEmbedder
from womblex_ingest.extraction import STUB_EMBEDDING_DIMENSIONS, STUB_EMBEDDING_MODEL
from womblex_ingest.records import make_query_embedding


def magnitude(values: list[float]) -> float:
    return math.sqrt(sum(value * value for value in values))


def test_stub_embedder_declares_the_stub_model_and_dimensions() -> None:
    embedding = StubTextEmbedder().embed("network security")

    assert embedding.model == STUB_EMBEDDING_MODEL
    assert embedding.dimensions == STUB_EMBEDDING_DIMENSIONS
    assert len(embedding.values) == STUB_EMBEDDING_DIMENSIONS


def test_stub_embedder_is_deterministic() -> None:
    first = StubTextEmbedder().embed("identical text")
    second = StubTextEmbedder().embed("identical text")

    assert first.to_json() == second.to_json()


def test_stub_embedder_ignores_surrounding_whitespace() -> None:
    # A topic definition should embed the same regardless of incidental padding.
    trimmed = StubTextEmbedder().embed("security controls")
    padded = StubTextEmbedder().embed("  security controls  ")

    assert trimmed.to_json() == padded.to_json()


def test_stub_embedder_distinguishes_different_text() -> None:
    assert StubTextEmbedder().embed("a").values != StubTextEmbedder().embed("b").values


def test_stub_query_vector_is_l2_normalised() -> None:
    embedding = StubTextEmbedder().embed("anything")

    assert magnitude(embedding.values) == pytest.approx(1.0)


def test_make_query_embedding_normalises_and_derives_dimensions() -> None:
    embedding = make_query_embedding(model="stub-deterministic-v1", values=[3.0, 4.0])

    assert embedding.dimensions == 2
    assert embedding.values == pytest.approx([0.6, 0.8])


def test_make_query_embedding_rejects_a_blank_model() -> None:
    with pytest.raises(ValueError, match="model"):
        make_query_embedding(model="  ", values=[1.0])


def test_make_query_embedding_rejects_no_values() -> None:
    with pytest.raises(ValueError, match="at least one"):
        make_query_embedding(model="stub-deterministic-v1", values=[])


def test_make_query_embedding_rejects_a_zero_vector() -> None:
    with pytest.raises(ValueError, match="zero-magnitude"):
        make_query_embedding(model="stub-deterministic-v1", values=[0.0, 0.0])


def test_query_embedding_to_json_is_the_wire_shape() -> None:
    embedding = make_query_embedding(model="stub-deterministic-v1", values=[3.0, 4.0])

    assert embedding.to_json() == {
        "model": "stub-deterministic-v1",
        "dimensions": 2,
        "values": [0.6, 0.8],
    }
