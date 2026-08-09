"""The money-span load path: womblex's `*.money_spans.parquet` → redline's store.

The sibling of `chunk_store.py`, over money instead of text. womblex's offline
`money` op writes one row per extracted amount; this module decodes those shards
and projects them into redline's own Postgres (ADR-0002/0017), where
`DrizzleMoneySpanStore` reads them back and the report tools address them.

**The span lands uninterpreted.** These are womblex's own 24 columns copied
across — three loci, the qualifiers it deliberately refuses to fold into `value`
(`modifier`, `multiplier`, `negative`) and the range grouping that separates a
range's lower endpoint from its upper. This writer decides nothing about what a
span *means*: not which requirement it belongs to, not what it converts to, not
whether it is a price at all. The moment it does, a second financial-data type
needs a second writer, and that is a build with no end. Attribution and roll-up
are a consumer's job, above the store.

`value` crosses as an exact decimal string, never a float: womblex writes
`decimal128(38, 4)` precisely because aggregating amounts accumulates float error
and reconciliation compares for equality.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Protocol, Sequence, Tuple

import pyarrow as pa
import pyarrow.parquet as pq

MONEY_SPANS_SUFFIX = ".money_spans.parquet"

# womblex's `MONEY_SPANS_SCHEMA`, mirrored exactly from `services/womblex` @
# `v0.3.0` (`src/womblex/store/money_output.py`). Mirrored rather than imported
# because the default validate box does not install the `[womblex]` extra;
# `test_the_mirrored_money_spans_schema_matches_the_engines` asserts the mirror
# against the real object whenever womblex IS importable, so the two cannot drift
# in silence.
MONEY_SPANS_SCHEMA = pa.schema([
    ("source_hash", pa.string()),
    ("locus", pa.string()),
    ("text_source", pa.string()),
    ("start_char", pa.int32()),
    ("end_char", pa.int32()),
    ("page", pa.int32()),
    ("elem_order", pa.int32()),
    ("parent_elem_order", pa.int32()),
    ("sheet", pa.string()),
    ("row", pa.int32()),
    ("col", pa.int32()),
    ("text", pa.string()),
    ("value", pa.decimal128(38, 4)),
    ("currency", pa.string()),
    ("currency_source", pa.string()),
    ("evidence", pa.string()),
    ("modifier", pa.string()),
    ("multiplier", pa.string()),
    ("negative", pa.bool_()),
    ("confidence", pa.float32()),
    ("range_group", pa.int32()),
    ("range_role", pa.string()),
    ("column_id", pa.string()),
    ("context", pa.string()),
])


class MoneySpanShardError(ValueError):
    """A money-span shard is missing a column the mapping requires.

    Raised rather than landing a half-populated span: a silently-dropped column is
    how the financial path came to read an empty table in the first place.
    """


@dataclass(frozen=True)
class MoneySpanRow:
    """One money span as womblex wrote it, keyed for redline's store.

    **Exactly one anchor group is non-null** — womblex's own invariant,
    discriminated by `locus`: `narrative` anchors on `start_char`/`end_char` in the
    layer `text_source` names, `table_cell` on
    `parent_element_order`/`row_index`/`column_index`, `sheet_cell` on
    `sheet`/`row_index`/`column_index` (+ `element_order`).
    """

    span_id: str
    document_id: str
    locus: str
    text_source: Optional[str]
    start_char: Optional[int]
    end_char: Optional[int]
    page: Optional[int]
    element_order: Optional[int]
    parent_element_order: Optional[int]
    sheet: Optional[str]
    row_index: Optional[int]
    column_index: Optional[int]
    text: str
    value: str
    currency: Optional[str]
    currency_source: Optional[str]
    evidence: Optional[str]
    modifier: Optional[str]
    multiplier: Optional[str]
    negative: bool
    confidence: float
    range_group: Optional[int]
    range_role: Optional[str]
    column_id: Optional[str]
    context: Optional[str]


class MoneySpanStore(Protocol):
    """The write surface. Reading is `DrizzleMoneySpanStore`'s, over the same table."""

    def replace_document_spans(
        self, evaluation_id: str, document_id: str, rows: Sequence[MoneySpanRow]
    ) -> None:
        """Land a document's spans, discarding any it already holds.

        Replace rather than upsert: the projection is rebuildable from the shards
        (ADR-0002), and a re-run over a re-annotated document must not leave the
        previous run's spans behind beside the new ones.
        """
        ...


def load_money_spans(store: MoneySpanStore, evaluation_id: str, shard_dir: Path) -> int:
    """Project every money-span shard under `shard_dir` into the store; return the row count.

    A directory with no `*.money_spans.parquet` loads nothing and does not fail:
    the money op is an optional overlay, so an evaluation it has not run over has
    no sidecars, which is an absent resource rather than a broken load — the same
    posture the embeddings seam takes.
    """
    shards = sorted(Path(shard_dir).glob(f"*{MONEY_SPANS_SUFFIX}"))
    if not shards:
        return 0

    by_document: Dict[str, List[dict]] = {}
    for shard in shards:
        for row in _read_shard(shard):
            by_document.setdefault(str(row["source_hash"]), []).append(row)

    loaded = 0
    for document_id, rows in by_document.items():
        projected = _project(document_id, rows)
        store.replace_document_spans(evaluation_id, document_id, projected)
        loaded += len(projected)
    return loaded


def _read_shard(path: Path) -> List[dict]:
    raw = pq.read_table(str(path))
    missing = [field.name for field in MONEY_SPANS_SCHEMA if field.name not in raw.schema.names]
    if missing:
        raise MoneySpanShardError(
            f"money-span shard {path} is missing columns {missing}; a womblex schema "
            "bump needs the mapping moved with it (money_span_store.py)"
        )
    return raw.select([field.name for field in MONEY_SPANS_SCHEMA]).to_pylist()


def _project(document_id: str, rows: List[dict]) -> List[MoneySpanRow]:
    occurrences: Dict[Tuple[str, str], int] = {}
    projected: List[MoneySpanRow] = []
    for row in rows:
        anchor = _anchor_key(row)
        occurrence = occurrences.get((document_id, anchor), 0)
        occurrences[(document_id, anchor)] = occurrence + 1
        projected.append(_to_span_row(f"{document_id}:{anchor}#{occurrence}", document_id, row))
    return projected


def _anchor_key(row: dict) -> str:
    """The span's provenance address, per locus.

    No anchor identifies a row on its own: womblex scans an unclassified column's
    cells for several self-evidencing amounts, and a range writes two rows sharing
    one narrative position — so `_project` appends an occurrence ordinal, which is
    stable because the shard's row order is.
    """
    locus = str(row["locus"])
    if locus == "narrative":
        return f"narrative:{row['start_char']}:{row['end_char']}"
    if locus == "sheet_cell":
        return f"sheet_cell:{row['sheet']}:{row['row']}:{row['col']}"
    return f"{locus}:{row['parent_elem_order']}:{row['row']}:{row['col']}"


def _to_span_row(span_id: str, document_id: str, row: dict) -> MoneySpanRow:
    return MoneySpanRow(
        span_id=span_id,
        document_id=document_id,
        locus=str(row["locus"]),
        text_source=_text(row["text_source"]),
        start_char=_integer(row["start_char"]),
        end_char=_integer(row["end_char"]),
        page=_integer(row["page"]),
        element_order=_integer(row["elem_order"]),
        parent_element_order=_integer(row["parent_elem_order"]),
        sheet=_text(row["sheet"]),
        row_index=_integer(row["row"]),
        column_index=_integer(row["col"]),
        text=str(row["text"] or ""),
        # `format(..., "f")` rather than `str`: a Decimal must never reach the
        # store in scientific notation, which numeric(38,4) would read as a
        # different amount.
        value=format(row["value"], "f"),
        currency=_text(row["currency"]),
        currency_source=_text(row["currency_source"]),
        evidence=_text(row["evidence"]),
        modifier=_text(row["modifier"]),
        multiplier=_text(row["multiplier"]),
        negative=bool(row["negative"]),
        confidence=float(row["confidence"]),
        range_group=_integer(row["range_group"]),
        range_role=_text(row["range_role"]),
        column_id=_text(row["column_id"]),
        context=_text(row["context"]),
    )


def _integer(value: object) -> Optional[int]:
    return None if value is None else int(value)  # type: ignore[arg-type]


def _text(value: object) -> Optional[str]:
    return None if value is None else str(value)


__all__ = [
    "MONEY_SPANS_SCHEMA",
    "MONEY_SPANS_SUFFIX",
    "MoneySpanRow",
    "MoneySpanShardError",
    "MoneySpanStore",
    "load_money_spans",
]
