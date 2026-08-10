"""Thread 56 (V1) — the real query-embedding binding, against womblex's real API.

The binding this replaces imported `embed_query` / `embedding_model_id` from
`womblex`, and **neither symbol exists**: `src/womblex/__init__.py` declares only a
docstring and `__version__`. Constructing the embedder raised `ImportError`, so the
real lane had no query vector, and with no query vector there is no retrieval.

The real path is `womblex.analyse.embed.embed_texts(texts, client, *, model, task)`
with a client from `womblex.cli._shared.make_isaacus_client` — verified against
`services/womblex` @ `v0.2.0`, not recalled.

These tests inject the engine call as a `QueryEmbedStage` rather than importing
womblex, so the binding's own contract — one text in, the query task, the declared
model, a normalised vector out — is provable in the default validate lane, with no
`.[womblex]` extra and no Isaacus key. Faking womblex here is faking a dependency
we do not own, not a port we do.
"""

from __future__ import annotations

import math
from typing import Any, List, Optional

import pytest

from womblex_ingest.real_extractor import (
    QUERY_TASK,
    QueryEmbedStage,
    RealWomblexTextEmbedder,
)

MODEL = "kanon-2-embedder"


class RecordingEmbedTexts:
    """Stands in for `womblex.analyse.embed.embed_texts`, with its real signature.

    Keyword-only `model`/`task` mirror the engine's, so a binding that passed them
    positionally would fail here exactly as it would against the real function.
    """

    def __init__(self, vectors: Optional[List[List[float]]] = None) -> None:
        self.vectors = [[3.0, 4.0]] if vectors is None else vectors
        self.calls: List[dict] = []

    def __call__(
        self,
        texts: List[str],
        client: object,
        *,
        model: str,
        task: Optional[str] = None,
        **kwargs: Any,
    ) -> List[List[float]]:
        self.calls.append({"texts": texts, "client": client, "model": model, "task": task})
        return self.vectors


def build_embedder(
    embed_texts: Optional[RecordingEmbedTexts] = None,
    model: str = MODEL,
) -> RealWomblexTextEmbedder:
    stage = QueryEmbedStage(
        embed_texts=embed_texts or RecordingEmbedTexts(),
        client=object(),
        model=model,
    )
    return RealWomblexTextEmbedder(stage=stage)


def test_embeds_the_single_query_text_through_womblex() -> None:
    embed_texts = RecordingEmbedTexts()

    build_embedder(embed_texts).embed("network security controls")

    assert len(embed_texts.calls) == 1
    assert embed_texts.calls[0]["texts"] == ["network security controls"]


def test_embeds_with_the_retrieval_query_task_not_the_document_task() -> None:
    # womblex's DEFAULT_TASK is "retrieval/document" — the *index* side. A query
    # embedded with it lands in a different space from the chunk vectors it is
    # matched against, which ranks noise without failing (womblex's embed
    # docstring: "Isaacus task types matter").
    embed_texts = RecordingEmbedTexts()

    build_embedder(embed_texts).embed("a topic definition")

    assert embed_texts.calls[0]["task"] == "retrieval/query"
    assert QUERY_TASK == "retrieval/query"


def test_embeds_with_the_model_the_chunk_vectors_declared() -> None:
    # The one mismatch retrieval refuses: chunks in model A, queries in model B.
    embed_texts = RecordingEmbedTexts()

    embedding = build_embedder(embed_texts, model="kanon-2-embedder-v9").embed("x")

    assert embed_texts.calls[0]["model"] == "kanon-2-embedder-v9"
    assert embedding.model == "kanon-2-embedder-v9"


def test_returns_a_normalised_vector_with_truthful_dimensions() -> None:
    embedding = build_embedder(RecordingEmbedTexts([[3.0, 4.0]])).embed("x")

    assert embedding.dimensions == 2
    assert embedding.values == [0.6, 0.8]
    assert math.isclose(math.sqrt(sum(v * v for v in embedding.values)), 1.0, rel_tol=1e-9)


def test_takes_the_first_vector_when_the_engine_batches() -> None:
    # embed_texts preserves input order and returns a list per text; one text in
    # means the query's vector is the first and only one we may read.
    embedding = build_embedder(RecordingEmbedTexts([[0.0, 5.0], [9.9, 9.9]])).embed("x")

    assert embedding.values == [0.0, 1.0]


def test_the_same_text_embeds_identically_twice() -> None:
    # Thread 20a's exit criterion, preserved: a definition must embed stably or a
    # captured fixture and content-addressed reuse both stop working.
    embedder = build_embedder()

    assert embedder.embed("network security").values == embedder.embed("network security").values


def test_an_empty_engine_response_is_refused() -> None:
    # A missing vector must fail at the seam: returning nothing downstream would
    # surface as an unranked topic, not as the engine call that silently failed.
    with pytest.raises(ValueError):
        build_embedder(RecordingEmbedTexts([])).embed("x")


def test_construction_does_not_import_womblex(monkeypatch: pytest.MonkeyPatch) -> None:
    # The read seam is a womblex-FREE image by design (architecture.md §1), but
    # `build_text_embedder("real")` runs at app start-up. Resolving the engine
    # binding in __init__ therefore made an unrelated capability — query
    # embedding, whose similarity search ADR-0018's addendum defers — fatal to
    # boot: the sidecar exited with ModuleNotFoundError before serving a single
    # extraction read. Construction must stay inert.
    def explode(*_args: Any, **_kwargs: Any) -> QueryEmbedStage:
        raise ModuleNotFoundError("No module named 'womblex'")

    monkeypatch.setattr(
        "womblex_ingest.real_extractor.load_womblex_query_embed_stage", explode
    )

    embedder = RealWomblexTextEmbedder()

    # Only asking for a vector may reach for the engine.
    with pytest.raises(ModuleNotFoundError):
        embedder.embed("x")
