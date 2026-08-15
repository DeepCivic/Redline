"""Item 1a — the psycopg-backed `ChunkStore` over redline's `redline_` schema.

The real implementation of `chunk_store.ChunkStore`, writing womblex's chunks +
embeddings into redline's own Postgres (ADR-0002). It is the store the report
assembler queries by provenance (ADR-0017), exposing only the *exact-fetch* half
(ADR-0018 addendum): `fetch_chunks` / `fetch_by_structure`, with the embedding held
**as available data** — no `pgvector` column, no ANN index, no `find_similar`.

psycopg is imported lazily (as `storage.py` does with boto3) so this module imports
for the DDL contract test without the driver installed; the store only touches
psycopg when constructed against a live DSN in a real-lane environment.
"""

from __future__ import annotations

import json
from typing import List, Sequence

from womblex_ingest.chunk_store import ChunkRow, StructureFilter

# The `redline_` chunk store — item 1a's first tables in redline's own schema.
#
# One table, `redline_chunks`, holds the addressable rows. The embedding rides as
# `embedding jsonb` (a plain float array) + `embedding_model text`: it is *loaded
# and available* per the ADR-0018 addendum, NOT under a `pgvector` column or an ANN
# index — enabling similarity search later is `ALTER TABLE ... ADD COLUMN embedding
# vector(...)` + an index build over data already present, a separate release.
#
# The exact key is `(evaluation_id, chunk_id)`; `chunk_id` is `{source_hash}:{index}`
# and `source_hash`/`chunk_index` are stored split so fetch_by_structure filters
# without parsing the composite. `CREATE ... IF NOT EXISTS` keeps a re-load (the
# projection is rebuildable from the MinIO shards, ADR-0002) idempotent.
REDLINE_CHUNK_STORE_DDL = """
CREATE TABLE IF NOT EXISTS redline_chunks (
    evaluation_id   text    NOT NULL,
    chunk_id        text    NOT NULL,
    source_hash     text    NOT NULL,
    chunk_index     integer NOT NULL,
    content_type    text    NOT NULL DEFAULT 'narrative',
    page            integer,
    text            text    NOT NULL,
    embedding       jsonb,
    embedding_model text,
    start_char      integer,
    end_char        integer,
    element_order   integer,
    PRIMARY KEY (evaluation_id, chunk_id)
);

-- `element_order`, not womblex's own `elem_order`: this table's columns follow
-- redline_money_spans' naming (also `element_order`), the two-DDL contract this
-- store's docstring names — the sidecar translates womblex's own vocabulary the
-- same way it already does for document_id -> source_hash below.
ALTER TABLE redline_chunks ADD COLUMN IF NOT EXISTS start_char integer;
ALTER TABLE redline_chunks ADD COLUMN IF NOT EXISTS end_char integer;
ALTER TABLE redline_chunks ADD COLUMN IF NOT EXISTS element_order integer;

CREATE INDEX IF NOT EXISTS redline_chunks_structure_idx
    ON redline_chunks (evaluation_id, source_hash, chunk_index);

CREATE INDEX IF NOT EXISTS redline_chunks_content_type_idx
    ON redline_chunks (evaluation_id, content_type);

-- Chunk element addressing (delivery-plan): a table-cell/sheet-cell money span
-- resolves to its chunk by (evaluation_id, source_hash, element_order).
CREATE INDEX IF NOT EXISTS redline_chunks_element_order_idx
    ON redline_chunks (evaluation_id, source_hash, element_order);
"""


class PostgresChunkStore:
    """`ChunkStore` over `redline_chunks`. Same Protocol as `InMemoryChunkStore`."""

    def __init__(self, dsn: str) -> None:
        import psycopg

        self._connect = lambda: psycopg.connect(dsn)

    def migrate(self) -> None:
        """Create the `redline_` chunk tables if absent (idempotent)."""
        with self._connect() as conn:
            conn.execute(REDLINE_CHUNK_STORE_DDL)
            conn.commit()

    def upsert_chunks(self, evaluation_id: str, rows: Sequence[ChunkRow]) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                for row in rows:
                    cur.execute(
                        """
                        INSERT INTO redline_chunks (
                            evaluation_id, chunk_id, source_hash, chunk_index,
                            content_type, page, text, embedding, embedding_model,
                            start_char, end_char, element_order
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (evaluation_id, chunk_id) DO UPDATE SET
                            source_hash     = EXCLUDED.source_hash,
                            chunk_index     = EXCLUDED.chunk_index,
                            content_type    = EXCLUDED.content_type,
                            page            = EXCLUDED.page,
                            text            = EXCLUDED.text,
                            embedding       = EXCLUDED.embedding,
                            embedding_model = EXCLUDED.embedding_model,
                            start_char      = EXCLUDED.start_char,
                            end_char        = EXCLUDED.end_char,
                            element_order   = EXCLUDED.element_order
                        """,
                        (
                            evaluation_id,
                            row.chunk_id,
                            row.document_id,
                            row.chunk_index,
                            row.content_type,
                            row.page,
                            row.text,
                            json.dumps(row.embedding) if row.embedding is not None else None,
                            row.embedding_model,
                            row.start_char,
                            row.end_char,
                            row.elem_order,
                        ),
                    )
            conn.commit()

    def fetch_chunks(self, evaluation_id: str, chunk_ids: Sequence[str]) -> List[ChunkRow]:
        if not chunk_ids:
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT source_hash, chunk_id, chunk_index, content_type,
                           page, text, embedding, embedding_model,
                           start_char, end_char, element_order
                    FROM redline_chunks
                    WHERE evaluation_id = %s AND chunk_id = ANY(%s)
                    """,
                    (evaluation_id, list(chunk_ids)),
                )
                by_id = {row[1]: _to_chunk_row(row) for row in cur.fetchall()}
        # Preserve the requested order; skip keys that did not resolve.
        return [by_id[chunk_id] for chunk_id in chunk_ids if chunk_id in by_id]

    def fetch_by_structure(self, evaluation_id: str, filter: StructureFilter) -> List[ChunkRow]:
        clauses = ["evaluation_id = %s"]
        params: List[object] = [evaluation_id]
        if filter.document_id is not None:
            clauses.append("source_hash = %s")
            params.append(filter.document_id)
        if filter.content_type is not None:
            clauses.append("content_type = %s")
            params.append(filter.content_type)
        if filter.page is not None:
            clauses.append("page = %s")
            params.append(filter.page)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f"""
                    SELECT source_hash, chunk_id, chunk_index, content_type,
                           page, text, embedding, embedding_model,
                           start_char, end_char, element_order
                    FROM redline_chunks
                    WHERE {' AND '.join(clauses)}
                    ORDER BY source_hash, chunk_index
                    """,
                    params,
                )
                return [_to_chunk_row(row) for row in cur.fetchall()]


def _to_chunk_row(row: Sequence[object]) -> ChunkRow:
    (
        source_hash, chunk_id, chunk_index, content_type, page, text, embedding, model,
        start_char, end_char, element_order,
    ) = row
    # psycopg decodes jsonb to a Python list already; guard the str case for a
    # driver/codec that hands back raw text.
    if isinstance(embedding, str):
        embedding = json.loads(embedding)
    return ChunkRow(
        document_id=str(source_hash),
        chunk_id=str(chunk_id),
        chunk_index=int(chunk_index),
        content_type=str(content_type),
        page=int(page) if page is not None else None,
        text=str(text),
        embedding=[float(v) for v in embedding] if embedding is not None else None,
        embedding_model=str(model) if model is not None else None,
        start_char=int(start_char) if start_char is not None else None,
        end_char=int(end_char) if end_char is not None else None,
        elem_order=int(element_order) if element_order is not None else None,
    )
