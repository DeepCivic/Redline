"""Item 1a — the store-side exact-fetch surface (ADR-0017/0018, Accepted 2026-07-31).

ADR-0017 puts womblex's bulk output (chunks + embeddings) into redline's own
`redline_` store, addressed by provenance and returned byte-identical, rather than
shipped to TypeScript. ADR-0018 names the query surface; its **addendum** ships the
*exact-fetch* half now (`fetch_chunks` / `fetch_by_structure`) and the embeddings
**loaded as available data**, and defers only vector *similarity search* (the
`pgvector`/ANN index + `findSimilar`) to a later release.

This is the store contract, proven on an in-memory fake so `validate.sh` #10 runs it
without a live Postgres — the same Protocol-plus-Fake idiom `storage.py` uses for
MinIO. `PostgresChunkStore` (psycopg) implements the same Protocol; its migration DDL
is asserted structurally in `test_chunk_store_migration.py`, and it is exercised
against a real DB only in a real-lane environment.

What this pins (the item-1a exit):
  * a loaded corpus lands chunk rows + embeddings in the store;
  * exact `fetch_chunks` returns byte-identical text for a stable key;
  * `fetch_by_structure` filters by document / content_type / page;
  * an absent embed stage leaves the embedding side empty — a chunk with no vector
    is served (NOT_FOUND on the vector, not a broken load);
  * a chunk carries its embedding *as data* (the addendum's "available, not indexed"),
    and no similarity/ANN surface exists yet.
"""

from __future__ import annotations

import math

import pytest

from womblex_ingest.chunk_store import (
    ChunkRow,
    InMemoryChunkStore,
    StructureFilter,
    load_document,
    load_extraction,
)
from womblex_ingest.records import (
    DocumentExtraction,
    ChunkRecord,
    ElementRecord,
    EmbeddingRecord,
    make_document_embeddings,
)
from womblex_ingest.shard_reader import ShardRows

SOURCE_HASH = "82f9355eabcd0001"
OTHER_HASH = "aaaa000011112222"
EVAL = "eval-9"


def _rows(source_hash: str) -> ShardRows:
    # Chunk shard rows carry `content_type` and `page` (womblex's chunk schema);
    # the store projects them into ChunkRow provenance. `records.py`/the JSON wire
    # are untouched by item 1a — the store reads the shard rows directly, being
    # the one place (with shard_reader) that understands womblex's schema.
    return ShardRows(
        source_hash=source_hash,
        elements=[{"elem_order": 0, "page": 1, "text": "e"}],
        chunks=[
            {"chunk_index": 0, "page": 1, "text": "Security posture: ISO 27001 certified."},
            {"chunk_index": 1, "page": 2, "text": "Pricing schedule follows.", "content_type": "table"},
        ],
    )


def _embeddings(source_hash: str):
    return make_document_embeddings(
        document_id=source_hash,
        model="kanon-2-embedder",
        vectors=[
            EmbeddingRecord(chunkId=f"{source_hash}:0", chunkIndex=0, values=[0.1, 0.2]),
            EmbeddingRecord(chunkId=f"{source_hash}:1", chunkIndex=1, values=[0.3, 0.4]),
        ],
    )


def test_load_lands_chunk_rows_addressable_by_stable_key() -> None:
    store = InMemoryChunkStore()

    load_document(store, EVAL, _rows(SOURCE_HASH), _embeddings(SOURCE_HASH))

    rows = store.fetch_chunks(EVAL, [f"{SOURCE_HASH}:0", f"{SOURCE_HASH}:1"])
    assert [r.chunk_id for r in rows] == [f"{SOURCE_HASH}:0", f"{SOURCE_HASH}:1"]


def test_fetch_chunks_returns_byte_identical_text() -> None:
    # The transfer mechanic (ADR-0017): the same query returns the same source
    # text womblex extracted, verbatim, so an LLM copies it into a report slot.
    store = InMemoryChunkStore()
    load_document(store, EVAL, _rows(SOURCE_HASH), _embeddings(SOURCE_HASH))

    (row,) = store.fetch_chunks(EVAL, [f"{SOURCE_HASH}:0"])

    assert row.text == "Security posture: ISO 27001 certified."
    assert row.document_id == SOURCE_HASH
    assert row.chunk_index == 0


def test_fetch_chunks_is_scoped_to_the_evaluation() -> None:
    # A key is only addressable within the evaluation it was loaded under; another
    # evaluation's identical source_hash must not leak across.
    store = InMemoryChunkStore()
    load_document(store, EVAL, _rows(SOURCE_HASH), _embeddings(SOURCE_HASH))

    assert store.fetch_chunks("other-eval", [f"{SOURCE_HASH}:0"]) == []


def test_fetch_chunks_orders_by_the_requested_keys_and_skips_the_absent() -> None:
    store = InMemoryChunkStore()
    load_document(store, EVAL, _rows(SOURCE_HASH), _embeddings(SOURCE_HASH))

    rows = store.fetch_chunks(EVAL, [f"{SOURCE_HASH}:1", "does:not-exist", f"{SOURCE_HASH}:0"])

    # Requested order preserved; the missing key is simply not returned (an exact
    # fetch of a stable key is a lookup, not a fuzzy match).
    assert [r.chunk_id for r in rows] == [f"{SOURCE_HASH}:1", f"{SOURCE_HASH}:0"]


def test_fetch_by_structure_filters_by_document() -> None:
    store = InMemoryChunkStore()
    load_document(store, EVAL, _rows(SOURCE_HASH), _embeddings(SOURCE_HASH))
    load_document(store, EVAL, _rows(OTHER_HASH), _embeddings(OTHER_HASH))

    rows = store.fetch_by_structure(EVAL, StructureFilter(document_id=SOURCE_HASH))

    assert {r.document_id for r in rows} == {SOURCE_HASH}
    assert [r.chunk_index for r in rows] == [0, 1]  # stable: by chunk_index


def test_fetch_by_structure_filters_by_content_type_and_page() -> None:
    store = InMemoryChunkStore()
    load_document(store, EVAL, _rows(SOURCE_HASH), _embeddings(SOURCE_HASH))

    tables = store.fetch_by_structure(EVAL, StructureFilter(content_type="table"))
    assert [r.chunk_id for r in tables] == [f"{SOURCE_HASH}:1"]

    page_one = store.fetch_by_structure(EVAL, StructureFilter(page=1))
    assert [r.chunk_id for r in page_one] == [f"{SOURCE_HASH}:0"]


def test_embedding_is_loaded_as_available_data_l2_normalised() -> None:
    # ADR-0018 addendum: the vector is present and addressable — "available, not
    # indexed". It crosses as data (a plain float list), never a pgvector column,
    # and stays L2-normalised so a future dot-product is the cosine (ADR-0014).
    store = InMemoryChunkStore()
    load_document(store, EVAL, _rows(SOURCE_HASH), _embeddings(SOURCE_HASH))

    (row,) = store.fetch_chunks(EVAL, [f"{SOURCE_HASH}:0"])

    assert row.embedding is not None
    assert row.embedding_model == "kanon-2-embedder"
    assert math.isclose(math.sqrt(sum(x * x for x in row.embedding)), 1.0, rel_tol=1e-9)


def test_absent_embed_stage_leaves_the_vector_side_empty_not_broken() -> None:
    # The exit's NOT_FOUND-not-broken clause: a load with no embeddings still lands
    # the chunk rows (extraction is queryable); the vector is simply absent.
    store = InMemoryChunkStore()

    load_document(store, EVAL, _rows(SOURCE_HASH), embeddings=None)

    (row,) = store.fetch_chunks(EVAL, [f"{SOURCE_HASH}:0"])
    assert row.text == "Security posture: ISO 27001 certified."
    assert row.embedding is None
    assert row.embedding_model is None


def test_store_exposes_no_similarity_surface_yet() -> None:
    # The addendum defers vector similarity search. The store must NOT carry a
    # find_similar / nearest-neighbour method this release — its absence is the
    # guard that we did not build the deferred half.
    store = InMemoryChunkStore()

    assert not hasattr(store, "find_similar")


def test_chunk_row_is_plain_data() -> None:
    # No vector engine type crosses the store's own surface: the embedding is a
    # list[float], the row is a frozen dataclass. (The redline-domain purity guard
    # is TS-side; this is its Python-side sibling — nothing pyarrow/pgvector here.)
    row = ChunkRow(
        document_id=SOURCE_HASH,
        chunk_id=f"{SOURCE_HASH}:0",
        chunk_index=0,
        content_type="narrative",
        page=1,
        text="x",
        embedding=[0.6, 0.8],
        embedding_model="kanon-2-embedder",
    )

    assert isinstance(row.embedding, list)
    with pytest.raises(Exception):
        row.text = "mutated"  # type: ignore[misc]  # frozen


# ── load_extraction: the /ingest load path over the JSON read model ──────────


def _extraction(source_hash: str) -> DocumentExtraction:
    # The mapped read model the /ingest route holds (records.py). It carries no
    # content_type/page on chunks — those take the store's defaults — but the
    # chunkId is the stable `{source_hash}:{index}` key the load recovers the
    # ordinal from and joins the vector on.
    return DocumentExtraction(
        documentId=source_hash,
        elements=[ElementRecord(documentId=source_hash, elementOrder=0, page=1, text="e")],
        chunks=[
            ChunkRecord(chunkId=f"{source_hash}:0", documentId=source_hash, text="Chunk zero text."),
            ChunkRecord(chunkId=f"{source_hash}:1", documentId=source_hash, text="Chunk one text."),
        ],
        tableCells=[],
    )


def test_load_extraction_lands_rows_from_the_json_read_model() -> None:
    # The item-1a exit clause the /ingest route drives: a load lands addressable,
    # byte-identical chunk rows from the mapped read model — identical shape to
    # load_document's raw-shard projection.
    store = InMemoryChunkStore()

    load_extraction(store, EVAL, _extraction(SOURCE_HASH), _embeddings(SOURCE_HASH))

    rows = store.fetch_chunks(EVAL, [f"{SOURCE_HASH}:0", f"{SOURCE_HASH}:1"])
    assert [r.chunk_id for r in rows] == [f"{SOURCE_HASH}:0", f"{SOURCE_HASH}:1"]
    assert rows[0].text == "Chunk zero text."
    assert rows[0].chunk_index == 0
    assert rows[1].chunk_index == 1


def test_load_extraction_joins_the_vector_on_chunk_id() -> None:
    # The vector is available data after the load, keyed on the same chunkId both
    # the extraction and embeddings resources carry (ADR-0014).
    store = InMemoryChunkStore()

    load_extraction(store, EVAL, _extraction(SOURCE_HASH), _embeddings(SOURCE_HASH))

    (row,) = store.fetch_chunks(EVAL, [f"{SOURCE_HASH}:0"])
    assert row.embedding is not None
    assert row.embedding_model == "kanon-2-embedder"
    assert math.isclose(math.sqrt(sum(x * x for x in row.embedding)), 1.0, rel_tol=1e-9)


def test_load_extraction_without_embeddings_lands_chunks_with_no_vector() -> None:
    # The absent-embed-stage path over the read model: the chunks are queryable,
    # the vector is simply absent (NOT_FOUND on the vector, not a broken load).
    store = InMemoryChunkStore()

    load_extraction(store, EVAL, _extraction(SOURCE_HASH), embeddings=None)

    (row,) = store.fetch_chunks(EVAL, [f"{SOURCE_HASH}:0"])
    assert row.text == "Chunk zero text."
    assert row.embedding is None
    assert row.embedding_model is None


def test_load_extraction_rejects_a_chunk_id_without_a_numeric_ordinal() -> None:
    # The stable key must carry its ordinal; a producer that broke that contract is
    # a loud failure at the seam, not an unaddressable row landed silently.
    store = InMemoryChunkStore()
    broken = DocumentExtraction(
        documentId=SOURCE_HASH,
        elements=[],
        chunks=[ChunkRecord(chunkId=f"{SOURCE_HASH}:not-a-number", documentId=SOURCE_HASH, text="x")],
        tableCells=[],
    )

    with pytest.raises(ValueError):
        load_extraction(store, EVAL, broken, embeddings=None)


def test_postgres_chunk_store_runtime_dependency_is_declared() -> None:
    # The store's driver is imported inside __init__, so an undeclared dependency
    # is invisible to every test that uses a fake — and only surfaces when a built
    # image boots with REDLINE_DATABASE_URL set, as ModuleNotFoundError before the
    # app serves anything. Importing it here binds the declaration to the suite.
    # A bad DSN must fail as a CONNECTION error, never as a missing module.
    import psycopg

    assert hasattr(psycopg, "connect")
