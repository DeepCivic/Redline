"""Item 1a — the `redline_` chunk-store schema, asserted structurally.

The `redline_` schema is redline's own (ADR-0002); item 1a adds its first tables —
the chunk store ADR-0017/0018 land womblex's bulk output into. This proves the DDL's
*shape* without a live Postgres (mirroring the numbatch financial extension's
`test_migration.py`): table names match `validate.sh` #7's `^redline_[a-z_]+$`, the
provenance keys are present, and — per the ADR-0018 addendum — **no `pgvector`/vector
column and no ANN index** exist yet (the vector is stored as available data).

The DDL string lives next to `PostgresChunkStore` so the store and its schema stay in
one place; this test reads it rather than a live database.
"""

from __future__ import annotations

import re

from womblex_ingest.chunk_store_postgres import REDLINE_CHUNK_STORE_DDL


def test_every_table_matches_the_redline_prefix_guard() -> None:
    # validate.sh #7 enforces ^redline_[a-z_]+$ on every table; the DDL must not
    # introduce one that would trip it.
    tables = re.findall(r"CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_]+)", REDLINE_CHUNK_STORE_DDL)
    assert tables, "the DDL must create at least one table"
    for table in tables:
        assert re.fullmatch(r"redline_[a-z_]+", table), table


def test_chunk_table_carries_the_provenance_keys() -> None:
    ddl = REDLINE_CHUNK_STORE_DDL.lower()
    for column in ("evaluation_id", "source_hash", "chunk_index", "content_type", "page", "text"):
        assert column in ddl, column
    # The exact-fetch key is (evaluation_id, chunk_id) / (evaluation_id, source_hash,
    # chunk_index); an index on the structural columns backs fetch_by_structure.
    assert "chunk_id" in ddl


def test_chunk_table_carries_the_element_range_it_was_cut_from() -> None:
    # Chunk element addressing (delivery-plan): the element range each chunk was
    # cut from, mirroring womblex's own CHUNKS_SCHEMA columns so a money span can
    # resolve to the one chunk containing it instead of to its whole document.
    ddl = REDLINE_CHUNK_STORE_DDL.lower()
    for column in ("start_char", "end_char", "elem_order"):
        assert column in ddl, column


def test_embedding_is_stored_as_available_data_not_a_vector_index() -> None:
    ddl = REDLINE_CHUNK_STORE_DDL.lower()
    # The embedding rides as data: a float array / jsonb column and a declared
    # model. No pgvector, no HNSW/ivfflat ANN index — the addendum defers that.
    assert "embedding" in ddl
    assert "model" in ddl
    assert "vector(" not in ddl, "pgvector column is deferred (ADR-0018 addendum)"
    assert "using hnsw" not in ddl and "using ivfflat" not in ddl, "ANN index is deferred"
    assert "create extension" not in ddl or "vector" not in ddl.split("create extension", 1)[1][:40]


def test_ddl_is_idempotent() -> None:
    # Loading is re-runnable (a rebuildable projection over the MinIO shards,
    # ADR-0002); the DDL must create-if-not-exists so a re-load is not an error.
    assert "if not exists" in REDLINE_CHUNK_STORE_DDL.lower()
