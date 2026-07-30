"""Item 1a — the store-side exact-fetch surface (ADR-0017/0018, Accepted 2026-07-31).

ADR-0017 lands womblex's bulk output (chunks + embeddings) in redline's own
`redline_` store, addressed by womblex provenance and returned byte-identical, so
the report-assembler LLM copies verbatim rows into a template rather than being
shipped GBs of JSON vectors (which ADR-0014's 50k-chunk trigger ruled out at the
measured ~90k-chunk corpus).

ADR-0018 specifies the query surface. Its **addendum** ships the *exact-fetch* half
now — `fetch_chunks` (by stable key) and `fetch_by_structure` (by document /
content_type / page) — with the embeddings **loaded as available data** (a plain,
L2-normalised float list, keyed on `(source_hash, chunk_index)`, declaring its
model — ADR-0014's surviving invariants). It **defers** vector *similarity search*:
there is deliberately **no `find_similar`, no pgvector column and no ANN index**
here. Enabling that later is building an index over data already in the store, not a
re-ingest.

Shape mirrors `storage.py`'s MinIO seam: a `ChunkStore` Protocol, an in-memory
`InMemoryChunkStore` fake the exit test drives (so `validate.sh` #10 runs without a
live Postgres), and a psycopg-backed `PostgresChunkStore` implementing the same
Protocol against the `redline_` schema (ADR-0002 — redline owns its Postgres).

`load_document` is the projection: it reads a document's `ShardRows` chunk rows —
being, with `shard_reader`, the one place that understands womblex's chunk schema
(`chunk_index`, `content_type`, `page`) — joins each to its vector, and writes the
result. It reads the raw shard rows rather than the mapped `ChunkRecord` precisely
so the JSON presentation seam (`records.py`) stays untouched by this store work.
`load_extraction` is its sibling for the caller that already holds the mapped
read model — the `/ingest` route — projecting a `DocumentExtraction` + its
`DocumentEmbeddings` into the same `ChunkRow`s, so an ingest lands the store
alongside the MinIO shards (the item-1a exit).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Protocol, Sequence, Tuple

from womblex_ingest.records import DocumentEmbeddings, DocumentExtraction
from womblex_ingest.shard_reader import ShardRows, _optional, _require


@dataclass(frozen=True)
class ChunkRow:
    """One addressable chunk in the store, with full provenance and its vector.

    `chunk_id` is `{source_hash}:{chunk_index}` — the seam's stable key (ADR-0014).
    `embedding` is the L2-normalised vector **as data** (`list[float]`), or ``None``
    when the embed stage did not run for this chunk — never a pgvector type, because
    the addendum defers the ANN index, and never a numpy/Arrow object, keeping the
    store's surface plain data (the Python-side sibling of redline-domain purity).
    """

    document_id: str
    chunk_id: str
    chunk_index: int
    content_type: str
    page: Optional[int]
    text: str
    embedding: Optional[List[float]]
    embedding_model: Optional[str]


@dataclass(frozen=True)
class StructureFilter:
    """A structural predicate over the exact-fetch surface.

    Every field is optional; a set field narrows the result, an unset one is
    ignored. This is the addressing half (document / content_type / page) — not a
    similarity query. Table (row, col) and heading filters join through the
    element/cell shards and are added when a consumer needs them.
    """

    document_id: Optional[str] = None
    content_type: Optional[str] = None
    page: Optional[int] = None


class ChunkStore(Protocol):
    """The exact-fetch store surface (ADR-0018, exact half only).

    Deliberately carries no similarity operation: `find_similar` is deferred by the
    ADR-0018 addendum, and its absence here is the guard that the deferred half was
    not built.
    """

    def upsert_chunks(self, evaluation_id: str, rows: Sequence[ChunkRow]) -> None:
        """Land (or replace) a document's chunk rows under an evaluation."""
        ...

    def fetch_chunks(self, evaluation_id: str, chunk_ids: Sequence[str]) -> List[ChunkRow]:
        """Return the rows for `chunk_ids`, in the requested order.

        A missing key is simply absent from the result (an exact lookup, not a
        fuzzy match); the caller sees which keys resolved by what comes back.
        """
        ...

    def fetch_by_structure(self, evaluation_id: str, filter: StructureFilter) -> List[ChunkRow]:
        """Return the rows matching every set field of `filter`, ordered by
        `(document_id, chunk_index)` so the result is stable."""
        ...


class InMemoryChunkStore:
    """A dependency-free `ChunkStore` for tests and the stub lane.

    Keyed on `(evaluation_id, chunk_id)`; insertion order is not relied on — reads
    impose their own order (requested order for `fetch_chunks`, provenance order for
    `fetch_by_structure`) so behaviour matches the Postgres implementation.
    """

    def __init__(self) -> None:
        self._rows: Dict[Tuple[str, str], ChunkRow] = {}

    def upsert_chunks(self, evaluation_id: str, rows: Sequence[ChunkRow]) -> None:
        for row in rows:
            self._rows[(evaluation_id, row.chunk_id)] = row

    def fetch_chunks(self, evaluation_id: str, chunk_ids: Sequence[str]) -> List[ChunkRow]:
        found: List[ChunkRow] = []
        for chunk_id in chunk_ids:
            row = self._rows.get((evaluation_id, chunk_id))
            if row is not None:
                found.append(row)
        return found

    def fetch_by_structure(self, evaluation_id: str, filter: StructureFilter) -> List[ChunkRow]:
        matches = [
            row
            for (eval_id, _), row in self._rows.items()
            if eval_id == evaluation_id and _matches(row, filter)
        ]
        matches.sort(key=lambda row: (row.document_id, row.chunk_index))
        return matches


def _matches(row: ChunkRow, filter: StructureFilter) -> bool:
    if filter.document_id is not None and row.document_id != filter.document_id:
        return False
    if filter.content_type is not None and row.content_type != filter.content_type:
        return False
    if filter.page is not None and row.page != filter.page:
        return False
    return True


def load_document(
    store: ChunkStore,
    evaluation_id: str,
    rows: ShardRows,
    embeddings: Optional[DocumentEmbeddings],
) -> None:
    """Project one document's shard rows (+ vectors) into the store.

    `content_type` defaults to womblex's own `narrative` when a chunk row omits it,
    and `page` is a legitimate nullable. Each chunk joins its vector on
    `(source_hash, chunk_index)`; a chunk with no vector (the absent-embed-stage
    path) lands with `embedding=None` — the extraction stays queryable, the vector
    is simply not there (NOT_FOUND on the vector, not a broken load — ADR-0018).
    """
    vectors_by_index: Dict[int, Tuple[List[float], str]] = {}
    if embeddings is not None:
        for vector in embeddings.vectors:
            vectors_by_index[vector.chunkIndex] = (list(vector.values), embeddings.model)

    projected: List[ChunkRow] = []
    for chunk_row in rows.chunks:
        chunk_index = int(_require(chunk_row, "chunk_index"))
        vector = vectors_by_index.get(chunk_index)
        projected.append(
            ChunkRow(
                document_id=rows.source_hash,
                chunk_id=f"{rows.source_hash}:{chunk_index}",
                chunk_index=chunk_index,
                content_type=str(_optional(chunk_row, "content_type") or "narrative"),
                page=_optional(chunk_row, "page", "page_number"),
                text=str(_require(chunk_row, "text", "chunk_text")),
                embedding=vector[0] if vector else None,
                embedding_model=vector[1] if vector else None,
            )
        )
    store.upsert_chunks(evaluation_id, projected)


def _chunk_index_from_id(chunk_id: str) -> int:
    """Recover the ordinal from a `{source_hash}:{chunk_index}` key.

    The stable key carries the ordinal as its suffix (ADR-0014); a key that does
    not is a producer that broke the seam's identity contract, so raising is
    correct rather than silently landing an unaddressable row.
    """
    _, _, suffix = chunk_id.rpartition(":")
    if not suffix.isdigit():
        raise ValueError(
            f"chunk id {chunk_id!r} does not end in a numeric chunk_index; "
            "the seam's stable key is '{source_hash}:{chunk_index}' (ADR-0014)"
        )
    return int(suffix)


def load_extraction(
    store: ChunkStore,
    evaluation_id: str,
    document: DocumentExtraction,
    embeddings: Optional[DocumentEmbeddings],
) -> None:
    """Project a document's JSON read model (+ vectors) into the store.

    This is the load path the `/ingest` route drives: it already holds the mapped
    `DocumentExtraction` and its `DocumentEmbeddings` sibling (the JSON seam,
    `records.py`), so the store is populated from those rather than re-reading the
    Parquet shards. `load_document` remains the raw-`ShardRows` projection for a
    caller that has decoded rows in hand; the two land identical `ChunkRow`s.

    Each chunk joins its vector on `chunkId` — the same key both resources carry
    — and its `chunk_index` is recovered from that key. `content_type`/`page` are
    absent from the JSON read model (it does not carry them), so they take the
    store's defaults (`narrative` / ``None``), exactly as `load_document` does for
    a chunk row that omits them. A chunk with no vector (the absent-embed-stage
    path) lands with `embedding=None` — the extraction stays queryable
    (NOT_FOUND on the vector, not a broken load — ADR-0018).
    """
    vectors_by_chunk_id: Dict[str, Tuple[List[float], str]] = {}
    if embeddings is not None:
        for vector in embeddings.vectors:
            vectors_by_chunk_id[vector.chunkId] = (list(vector.values), embeddings.model)

    projected: List[ChunkRow] = []
    for chunk in document.chunks:
        vector = vectors_by_chunk_id.get(chunk.chunkId)
        projected.append(
            ChunkRow(
                document_id=document.documentId,
                chunk_id=chunk.chunkId,
                chunk_index=_chunk_index_from_id(chunk.chunkId),
                content_type="narrative",
                page=None,
                text=chunk.text,
                embedding=vector[0] if vector else None,
                embedding_model=vector[1] if vector else None,
            )
        )
    store.upsert_chunks(evaluation_id, projected)
