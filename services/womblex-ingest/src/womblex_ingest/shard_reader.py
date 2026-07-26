"""Thread 37b — the womblex-schema → JSON-seam mapping.

This module is the **one place** that understands womblex's real Parquet schema
(the vocabulary named in `dev-iteration-2.md` / ADR-0008: `source_hash`,
`elem_order`, `chunk_index`, currency cells, and the `(source_hash, chunk_index,
content_type)` embedding join). It maps that schema into the `records.py`
dataclasses the Parquet→JSON boundary serves; everything downstream sees JSON.

Why it is separate from `real_extractor.py`: the *mapping* is pure and testable
with plain Python row dicts, so the schema contract can be proven without the
heavy womblex/pyarrow stack installed or a real corpus present. `real_extractor`
supplies the rows (by reading the Parquet shards the womblex pod landed in
MinIO); this module turns rows into records. The seam between them is the
`ShardRows` bundle below — a per-document collection of already-decoded rows.

Column names are read defensively: womblex's provenance keys are pinned by the
design docs, but a producer may spell a nullable field either of two documented
ways (e.g. a currency-typed cell as `sheet_cell` vs `table_cells`). Anything the
mapping cannot honour is a *finding* to be raised as its own thread + ADR
amendment (thread-37b scope note), not silently coerced — so a missing required
key raises rather than emitting a half-populated record.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

from womblex_ingest.records import (
    ChunkRecord,
    DocumentEmbeddings,
    DocumentExtraction,
    ElementRecord,
    EmbeddingRecord,
    TableCellRecord,
    make_document_embeddings,
)

Row = Mapping[str, Any]


class ShardSchemaError(ValueError):
    """A womblex shard row is missing a key the mapping requires.

    Raised rather than emitting a half-populated record: a silently-dropped
    provenance key fails downstream as a bad classification, not loudly at the
    seam. This is the "forced wire change is a finding" guard in code form.
    """


@dataclass(frozen=True)
class ShardRows:
    """One document's already-decoded womblex rows, grouped by shard kind.

    `source_hash` is womblex's document identity — the `documentId` the whole
    read model keys on. `model` is the embed stage's declared model, carried
    here so the embeddings resource can declare it (ADR-0014); it is ``None``
    when the embed stage did not run, which is the NOT_FOUND path, not an error.
    """

    source_hash: str
    elements: Sequence[Row] = field(default_factory=list)
    chunks: Sequence[Row] = field(default_factory=list)
    table_cells: Sequence[Row] = field(default_factory=list)
    embeddings: Sequence[Row] = field(default_factory=list)
    model: Optional[str] = None


def _require(row: Row, *keys: str) -> Any:
    """Return the first present key's value, or raise `ShardSchemaError`.

    Accepts aliases so a documented spelling variant (e.g. `elem_order` /
    `element_order`) maps without the caller branching.
    """
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    raise ShardSchemaError(
        f"womblex row is missing a required key (looked for {', '.join(keys)}): {dict(row)!r}"
    )


def _optional(row: Row, *keys: str) -> Optional[Any]:
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    return None


def _as_bool(value: Any) -> bool:
    # Parquet may decode a boolean column as a real bool, or a producer may carry
    # currency-typing as an int/str flag; normalise without inventing truthiness.
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return bool(value)


def map_element(source_hash: str, row: Row) -> ElementRecord:
    """`source_hash` → documentId, `elem_order` → elementOrder (design §)."""
    return ElementRecord(
        documentId=source_hash,
        elementOrder=int(_require(row, "elem_order", "element_order")),
        page=_optional(row, "page", "page_number"),
        text=str(_require(row, "text")),
    )


def map_chunk(source_hash: str, row: Row) -> ChunkRecord:
    """chunkId is `{source_hash}:{chunk_index}` — the seam's join key.

    A womblex chunk carries `chunk_index`; some producers also carry a native
    `chunk_id`. We *always* recompose the id from `(source_hash, chunk_index)` so
    the extraction and embeddings resources join on the identity ADR-0014 pins,
    rather than trusting two independently-produced strings to agree.
    """
    chunk_index = int(_require(row, "chunk_index"))
    return ChunkRecord(
        chunkId=f"{source_hash}:{chunk_index}",
        documentId=source_hash,
        text=str(_require(row, "text", "chunk_text")),
    )


def map_table_cell(source_hash: str, row: Row) -> TableCellRecord:
    """A currency-typed (or plain) cell from `table_cells` / `sheet_cell`."""
    return TableCellRecord(
        documentId=source_hash,
        elementOrder=int(_require(row, "elem_order", "element_order")),
        page=_optional(row, "page", "page_number"),
        rowIndex=int(_require(row, "row_index", "row")),
        columnIndex=int(_require(row, "col_index", "column_index", "column")),
        rawValue=str(_require(row, "raw_value", "value", "text")),
        isCurrency=_as_bool(_optional(row, "is_currency", "currency") or False),
    )


def map_document_extraction(rows: ShardRows) -> DocumentExtraction:
    """Assemble one document's read model from its element/chunk/cell rows.

    Chunks are ordered by `chunk_index` so the emitted `chunks` list is stable
    and its ordinals are contiguous — the property the embeddings join relies on.
    """
    chunks = sorted(rows.chunks, key=lambda row: int(_require(row, "chunk_index")))
    return DocumentExtraction(
        documentId=rows.source_hash,
        elements=[map_element(rows.source_hash, row) for row in rows.elements],
        chunks=[map_chunk(rows.source_hash, row) for row in chunks],
        tableCells=[map_table_cell(rows.source_hash, row) for row in rows.table_cells],
    )


def map_document_embeddings(rows: ShardRows) -> Optional[DocumentEmbeddings]:
    """Assemble the embeddings sibling, or ``None`` when the embed stage is absent.

    A document with no `*.embeddings.parquet` (the air-gapped / Isaacus-off path)
    yields ``None`` — an absent resource, mapped upstream to `NOT_FOUND` — never
    an empty payload (ADR-0014). Each vector joins its chunk on
    `(source_hash, chunk_index)`, recomposed into the `chunkId` the extraction
    also carries, and the resource declares the model womblex's embed stage used.
    """
    if not rows.embeddings:
        return None
    if not rows.model:
        # The embed stage ran but did not declare its model: refuse rather than
        # emit vectors a consumer cannot confirm are in the query's space.
        raise ShardSchemaError(
            f"embeddings for {rows.source_hash} carry no declared model; "
            "a consumer cannot confirm they match the query vectors' space (ADR-0014)"
        )
    vectors: List[EmbeddingRecord] = []
    for row in sorted(rows.embeddings, key=lambda r: int(_require(r, "chunk_index"))):
        chunk_index = int(_require(row, "chunk_index"))
        vectors.append(
            EmbeddingRecord(
                chunkId=f"{rows.source_hash}:{chunk_index}",
                chunkIndex=chunk_index,
                values=[float(value) for value in _require(row, "embedding", "values", "vector")],
            )
        )
    # `make_document_embeddings` re-L2-normalises and re-validates; a producer that
    # already normalised pays only an idempotent second pass.
    return make_document_embeddings(
        document_id=rows.source_hash,
        model=rows.model,
        vectors=vectors,
    )


def group_rows_by_document(
    *,
    elements: Sequence[Row],
    chunks: Sequence[Row],
    table_cells: Sequence[Row],
    embeddings: Sequence[Row],
    models_by_source_hash: Mapping[str, str],
) -> List[ShardRows]:
    """Fan a flat set of decoded shard rows out into one `ShardRows` per document.

    womblex batches multiple documents into one shard set, tagging every row with
    its `source_hash`; this regroups them so the mapping runs per document. A
    document that appears only in the embeddings shard (no elements) is ignored —
    an embedding with no chunk to attach to is not a document we can serve.
    """
    by_hash: Dict[str, Dict[str, List[Row]]] = {}

    def bucket(kind: str, rows: Sequence[Row]) -> None:
        for row in rows:
            source_hash = str(_require(row, "source_hash", "source_doc_id"))
            by_hash.setdefault(source_hash, {"elements": [], "chunks": [], "table_cells": [], "embeddings": []})
            by_hash[source_hash][kind].append(row)

    bucket("elements", elements)
    bucket("chunks", chunks)
    bucket("table_cells", table_cells)
    bucket("embeddings", embeddings)

    documents: List[ShardRows] = []
    for source_hash, grouped in by_hash.items():
        if not grouped["elements"] and not grouped["chunks"]:
            # No structural content — do not synthesise a document from stray cells
            # or orphan vectors.
            continue
        documents.append(
            ShardRows(
                source_hash=source_hash,
                elements=grouped["elements"],
                chunks=grouped["chunks"],
                table_cells=grouped["table_cells"],
                embeddings=grouped["embeddings"],
                model=models_by_source_hash.get(source_hash),
            )
        )
    return documents
