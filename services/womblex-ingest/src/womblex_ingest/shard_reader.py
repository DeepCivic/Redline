"""Thread 37b — the womblex-schema → JSON-seam mapping.

This module is the **one place** that understands womblex's real Parquet schema —
`source_hash`, `elem_order` on elements but `parent_elem_order` on table cells,
`chunk_index`, and the `(source_hash, chunk_index, content_type)` embedding join.
It maps that schema into the `records.py` dataclasses the Parquet→JSON boundary
serves; everything downstream sees JSON.

The schema here is the one `services/womblex` @ `v0.2.0` actually writes
(`src/womblex/store/output.py`), read from the submodule rather than assumed.
An earlier version of this mapping was written against invented column names —
`elem_order`/`col_index`/`is_currency` on table cells — which raised on every
real row; `tests/test_real_extractor.py` now pins the mirror against the engine's
own schema object so that cannot recur silently.

Why it is separate from `real_extractor.py`: the *mapping* is pure and testable
with plain Python row dicts, so the schema contract can be proven without the
heavy womblex/pyarrow stack installed or a real corpus present. `real_extractor`
supplies the rows (by reading the Parquet shards the womblex pod landed in
MinIO); this module turns rows into records. The seam between them is the
`ShardRows` bundle below — a per-document collection of already-decoded rows.

Column names are read defensively, but only across spellings womblex genuinely
writes: a table cell arrives from `table_cells` (`parent_elem_order`) or from a
`sheet_cell` element (`elem_order`), and one mapping serves both. Anything the
mapping cannot honour is a *finding* to be raised as its own thread + ADR, not
silently coerced — so a missing required *key* raises rather than emitting a
half-populated record.

The one field that is legitimately absent, not a finding, is an element's `text`
: womblex's `Element.text` is `str | None`, and every non-text kind
(`table`, `image`, `figure`, `form`, `page_break`, `sheet_meta`, `sheet_cell`)
serialises `text: None`. `map_element` maps those elements too — falling back to
`alt_text` then `""` — because raising on one would lose the whole document, and
every real tender carries tables.
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


# Currency derivation (ADR-0016). womblex writes cell values verbatim and has no
# currency capability at all: `value_type` is always "text" at v0.2.0 and
# `number_format` is left unset, so `isCurrency` is derived here from the text.
# Both columns are still read first, so a future openpyxl-based reader upgrades
# the signal without a redline change.
_CURRENCY_SYMBOLS = ("$", "€", "£", "¥")
_CURRENCY_CODES = ("AUD", "USD", "EUR", "GBP", "NZD", "SGD", "CAD", "JPY")
_CURRENCY_VALUE_TYPES = frozenset({"currency", "money"})
# "A$", "AU$", "US$", "NZ$" — longer prefixes are prose that contains a symbol.
_MAX_SYMBOL_PREFIX = 2


def derive_is_currency(
    raw_value: str,
    *,
    value_type: Optional[Any] = None,
    number_format: Optional[Any] = None,
) -> bool:
    """Is this cell a currency amount? (ADR-0016)

    Requires an explicit marker: a bare number is **not** currency. redline cannot
    distinguish a price from a quantity or a weighting without one, and a tender's
    response tables carry all three — so the permissive reading would sum unrelated
    columns into a pricing pivot that looks entirely plausible.
    """
    if value_type is not None and str(value_type).strip().lower() in _CURRENCY_VALUE_TYPES:
        return True
    if number_format is not None and _format_declares_currency(str(number_format)):
        return True
    return _text_declares_currency(raw_value)


def _format_declares_currency(number_format: str) -> bool:
    if any(symbol in number_format for symbol in _CURRENCY_SYMBOLS):
        return True
    upper = number_format.upper()
    return any(code in upper for code in _CURRENCY_CODES)


def _text_declares_currency(raw_value: str) -> bool:
    text = raw_value.strip()
    if not text:
        return False
    if text.startswith("(") and text.endswith(")"):
        # Accounting notation for a negative amount: ($1,234.56).
        text = text[1:-1].strip()
    text = text.lstrip("+-").strip()
    # A cell may carry a code *and* a symbol ("AUD $1,234.56"), so strip at most
    # two markers. Bounded deliberately: "AUD price" must still not be currency.
    for _ in range(2):
        remainder = _without_currency_marker(text)
        if remainder is None:
            return False
        if _is_plain_number(remainder):
            return True
        text = remainder
    return False


def _without_currency_marker(text: str) -> Optional[str]:
    """The text after removing one leading/trailing currency marker, else ``None``."""
    upper = text.upper()
    for code in _CURRENCY_CODES:
        if upper.startswith(code):
            return text[len(code) :].strip()
        if upper.endswith(code):
            return text[: -len(code)].strip()
    for symbol in _CURRENCY_SYMBOLS:
        position = text.find(symbol)
        if position < 0:
            continue
        prefix = text[:position]
        if prefix and not (prefix.isalpha() and len(prefix) <= _MAX_SYMBOL_PREFIX):
            return None
        return text[position + 1 :].strip()
    return None


def _is_plain_number(text: str) -> bool:
    """Is the whole string a plain decimal number, ignoring thousands separators?

    Deliberately not `float()`: that accepts "nan", "inf" and "1e5", none of which
    is a tender price, and each of which would flag a prose cell as currency.
    """
    candidate = text.replace(",", "").replace(" ", "").lstrip("+-")
    if not candidate or candidate.count(".") > 1:
        return False
    digits = candidate.replace(".", "")
    return digits.isascii() and digits.isdigit()


def map_element(source_hash: str, row: Row) -> ElementRecord:
    """`source_hash` → documentId, `elem_order` → elementOrder (design §).

    `text` is **not** required. womblex's `Element.text` is `str |
    None`: only the text-bearing kinds (`TEXT_KINDS`) populate it, while `table`,
    `image`, `figure`, `form`, `page_break`, `sheet_meta` and `sheet_cell`
    serialise `text: None`. Requiring it here raised `ShardSchemaError` on the
    first non-text element and — via `map_document_extraction`, which maps every
    row — lost the whole document, including its `table` element and therefore all
    of its pricing. Every element is kept so `elementOrder` provenance stays
    contiguous; the visible text falls back to `alt_text` (which `ELEMENT_SCHEMA`
    carries for `image`/`figure`) then to `""`. `ExtractionElement.text` is a
    non-nullable `string` in `redline-domain`, so `""` — not `None` — is the
    honest empty (a sibling of ADR-0016's verbatim-value contract decision).
    """
    text = _optional(row, "text", "alt_text")
    return ElementRecord(
        documentId=source_hash,
        elementOrder=int(_require(row, "elem_order", "element_order")),
        page=_optional(row, "page", "page_number"),
        text=str(text) if text is not None else "",
    )


def map_chunk(source_hash: str, row: Row) -> ChunkRecord:
    """chunkId is `{source_hash}:{chunk_index}` — the seam's join key.

    A womblex chunk carries `chunk_index`; some producers also carry a native
    `chunk_id`. We *always* recompose the id from `(source_hash, chunk_index)` so
    the extraction and embeddings resources join on the identity ADR-0014 pins,
    rather than trusting two independently-produced strings to agree.

    `startChar`/`endChar`/`elementOrder` carry the element range this chunk was
    cut from (delivery-plan "Chunk element addressing") straight off the shard
    row — womblex's CHUNKS_SCHEMA already writes them, split by content type
    (narrative gets offsets, a table chunk gets its anchor element order, see
    `ChunkRecord`'s docstring). `content_type` defaults to `narrative`, matching
    the store's own default for a producer that omits it.
    """
    chunk_index = int(_require(row, "chunk_index"))
    return ChunkRecord(
        chunkId=f"{source_hash}:{chunk_index}",
        documentId=source_hash,
        text=str(_require(row, "text", "chunk_text")),
        contentType=str(_optional(row, "content_type") or "narrative"),
        startChar=_optional(row, "start_char"),
        endChar=_optional(row, "end_char"),
        elementOrder=_optional(row, "elem_order", "element_order"),
    )


def map_table_cell(source_hash: str, row: Row) -> TableCellRecord:
    """A cell from `table_cells`, or from a `sheet_cell` element.

    womblex's `TABLE_CELLS_SCHEMA` is `(source_hash, parent_elem_order, row, col,
    value, rowspan, colspan, value_type)` — note `parent_elem_order`, not
    `elem_order`, and no page and no currency column anywhere. A `sheet_cell`
    *element* carries the same payload under `elem_order`/`row`/`col`/`value` and
    does have a page, so both spellings are accepted here and nowhere else.
    `isCurrency` is derived, never read — see `derive_is_currency` (ADR-0016).
    """
    raw_value = str(_require(row, "value", "raw_value", "text"))
    return TableCellRecord(
        documentId=source_hash,
        elementOrder=int(_require(row, "parent_elem_order", "elem_order", "element_order")),
        page=_optional(row, "page", "page_number"),
        rowIndex=int(_require(row, "row", "row_index")),
        columnIndex=int(_require(row, "col", "col_index", "column_index", "column")),
        rawValue=raw_value,
        isCurrency=derive_is_currency(
            raw_value,
            value_type=_optional(row, "value_type"),
            number_format=_optional(row, "number_format"),
        ),
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
