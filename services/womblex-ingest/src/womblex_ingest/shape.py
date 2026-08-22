"""How big a corpus, run or document is — answered without reading it.

A client asks for shape so it can size a retrieval before making one: how many
elements this document holds, which kinds are in it, which printed pages it spans.
That is only worth asking if asking is cheaper than reading, so this module is
built around what Parquet lets you learn without decoding rows:

**Counts come from the footer.** `pyarrow.parquet.read_metadata` reads a file's
row count out of its footer, decoding no rows at all. A corpus-scope or run-scope
shape therefore costs one footer read per shard file, whatever the run holds.

**Tallies project one column.** A document-scoped count or a `kind` tally reads
the identity column and the tallied labels through `read_table(columns=[...])` —
never the twenty-column row. On the real elements shard, `text` alone is 30% of
the payload and the geometry another 16%, none of which a sizing question needs.

Two limits are deliberate. **Tallies are document-scope only**, because a tally
over a whole run scales with the run while the question it answers is always asked
about one document. And **the tallied columns are closed-vocabulary labels** —
`kind`, `entity_label`, `relation` — never extracted text: an entity `name` is
unbounded and it is content, so it is not tallied here.

Everything this module returns is derived. It is aggregate metadata about rows,
not rows, and it belongs under its own labelled keys wherever it is served — the
verbatim seam is `shards.read_shard`, and nothing here substitutes for it.
"""

from __future__ import annotations

import io
from collections import Counter
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

from womblex_ingest.shards import (
    ASSETS,
    Asset,
    Column,
    identity_candidates,
    jsonable,
    list_runs,
    shard_keys,
)
from womblex_ingest.storage import ObjectStorage

# The columns worth tallying, per asset. Every one is a closed vocabulary womblex
# writes from a fixed set, so a tally stays small and says something a client can
# act on. `table_cells` tallies `parent_elem_order` because that answers "which
# tables does this document have, and how big is each" — the question asked
# before reading a pricing schedule.
TALLY_COLUMNS: Dict[str, Tuple[str, ...]] = {
    "elements": ("kind", "extractor"),
    "table_cells": ("parent_elem_order",),
    "form_fields": ("field_type",),
    "manifest": ("status", "ext", "extraction_method"),
    "money_spans": ("locus", "currency", "evidence"),
    "entities": ("entity_label", "entity_type"),
    "graph_edges": ("relation",),
    "enrichment_meta": ("doc_type_enriched", "jurisdiction"),
}

# Columns whose min and max are the useful answer rather than their distinct
# values — a printed page range narrows a retrieval the way a tally cannot.
RANGE_COLUMNS: Dict[str, Tuple[str, ...]] = {
    "elements": ("page",),
    "money_spans": ("page",),
}

# A tally that could grow without bound stops being metadata. Fifty distinct
# values is far above any womblex vocabulary and still small enough to read.
MAX_TALLY_VALUES = 50


@dataclass(frozen=True)
class Tally:
    """Distinct values of one column and how many rows carry each."""

    counts: List[Tuple[Any, int]]
    distinct: int
    truncated: bool

    def to_json(self) -> dict:
        return {
            "counts": [{"value": value, "rows": rows} for value, rows in self.counts],
            "distinct": self.distinct,
            "truncated": self.truncated,
        }


@dataclass(frozen=True)
class AssetShape:
    """One shard family's size, and — at document scope — its shape.

    `rows` is `None` only for an asset redline refuses to serve: `present` already
    tells a client the run holds it, and a count would be redline answering about
    rows it will not hand over.
    """

    name: str
    present: bool
    readable: bool
    rows: Optional[int]
    columns: List[Column]
    values: Dict[str, Tally]
    ranges: Dict[str, Tuple[Any, Any]]

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "present": self.present,
            "readable": self.readable,
            "rows": self.rows,
            "columns": [{"name": c.name, "type": c.type} for c in self.columns],
            "values": {name: tally.to_json() for name, tally in self.values.items()},
            "ranges": {
                name: {"min": bounds[0], "max": bounds[1]}
                for name, bounds in self.ranges.items()
            },
        }


@dataclass(frozen=True)
class RunShape:
    run_id: str
    versioned: bool
    documents: int
    assets: List[AssetShape]

    def to_json(self) -> dict:
        return {
            "runId": self.run_id,
            "versioned": self.versioned,
            "documents": self.documents,
            "assets": [asset.to_json() for asset in self.assets],
        }


@dataclass(frozen=True)
class CorpusShape:
    corpus_id: str
    run_id: Optional[str]
    document_id: Optional[str]
    documents: int
    runs: List[RunShape]

    def to_json(self) -> dict:
        return {
            "corpusId": self.corpus_id,
            "runId": self.run_id,
            "documentId": self.document_id,
            "documents": self.documents,
            "runs": [run.to_json() for run in self.runs],
        }


def read_shape(
    storage: ObjectStorage,
    corpus_id: str,
    *,
    run_id: Optional[str] = None,
    document_id: Optional[str] = None,
) -> CorpusShape:
    """Size a corpus, one run, or one document within a run.

    Runs are reported separately at every scope. Merging them would double every
    count and leave the provenance keys identifying nothing, which is the failure
    run-scoping exists to prevent.
    """
    wanted = [
        run for run in list_runs(storage, corpus_id) if run_id in (None, run.run_id)
    ]
    runs = [
        _run_shape(
            storage,
            corpus_id,
            run.run_id,
            run.versioned,
            document_id,
            scoped_to_one_run=run_id is not None,
        )
        for run in wanted
    ]
    return CorpusShape(
        corpus_id=corpus_id,
        run_id=run_id,
        document_id=document_id,
        documents=sum(run.documents for run in runs),
        runs=runs,
    )


def _run_shape(
    storage: ObjectStorage,
    corpus_id: str,
    run_id: str,
    versioned: bool,
    document_id: Optional[str],
    scoped_to_one_run: bool,
) -> RunShape:
    assets = [
        _asset_shape(
            storage,
            corpus_id,
            run_id,
            asset,
            document_id,
            # A corpus scope asks which runs exist and how big each is, not what
            # shape their schemas are. Twelve assets' column lists are ~20KB of
            # payload that answers a question nobody asked at this scope, and the
            # run scope below is one call away for a client that wants them.
            include_columns=scoped_to_one_run,
        )
        for asset in ASSETS.values()
    ]
    return RunShape(
        run_id=run_id,
        versioned=versioned,
        documents=_document_count(assets, document_id),
        assets=assets,
    )


def _document_count(assets: Sequence[AssetShape], document_id: Optional[str]) -> int:
    """How many documents this run's answer covers.

    The manifest carries one row per document, so its row count *is* the run's
    document count — no other shard can say this without decoding rows. A
    document-scoped read asks a narrower question, "is this document in this
    run", and answers it from any asset holding a row: a run whose elements hold
    the document but whose manifest was never staged still holds the document,
    and reporting nought beside a non-zero element count would be a contradiction
    a client cannot act on.
    """
    if document_id is None:
        manifest = next(asset for asset in assets if asset.name == "manifest")
        return manifest.rows or 0
    return 1 if any(asset.rows for asset in assets) else 0


def _asset_shape(
    storage: ObjectStorage,
    corpus_id: str,
    run_id: str,
    asset: Asset,
    document_id: Optional[str],
    include_columns: bool,
) -> AssetShape:
    keys = shard_keys(storage, corpus_id, run_id, asset)
    if not keys:
        return _empty(asset, present=False)
    if not asset.readable:
        return _empty(asset, present=True)

    columns = _schema_of(storage, keys[0]) if include_columns else []
    if document_id is None:
        return AssetShape(
            name=asset.name,
            present=True,
            readable=True,
            rows=sum(_row_count(storage, key) for key in keys),
            columns=columns,
            values={},
            ranges={},
        )
    return _document_shape(storage, keys, asset, columns, document_id)


def _document_shape(
    storage: ObjectStorage,
    keys: Sequence[str],
    asset: Asset,
    columns: List[Column],
    document_id: str,
) -> AssetShape:
    present = {column.name for column in columns}
    identity = [name for name in identity_candidates(asset) if name in present]
    if not identity:
        return AssetShape(asset.name, True, True, 0, columns, {}, {})

    tallied = [name for name in TALLY_COLUMNS.get(asset.name, ()) if name in present]
    ranged = [name for name in RANGE_COLUMNS.get(asset.name, ()) if name in present]
    projected = list(dict.fromkeys(identity + tallied + ranged))

    rows: List[Dict[str, Any]] = []
    for key in keys:
        for row in _project(storage, key, projected):
            if any(row.get(column) == document_id for column in identity):
                rows.append(row)

    return AssetShape(
        name=asset.name,
        present=True,
        readable=True,
        rows=len(rows),
        columns=columns,
        values={name: _tally(rows, name) for name in tallied},
        ranges=_ranges(rows, ranged),
    )


def _empty(asset: Asset, *, present: bool) -> AssetShape:
    return AssetShape(
        name=asset.name,
        present=present,
        readable=asset.readable,
        rows=None if not asset.readable else 0,
        columns=[],
        values={},
        ranges={},
    )


def _tally(rows: Sequence[Dict[str, Any]], column: str) -> Tally:
    counts = Counter(
        jsonable(row[column]) for row in rows if row.get(column) is not None
    )
    # Ordered by frequency, then by the value's own text so a tie is stable across
    # calls and across the mixed types these columns hold.
    ordered = sorted(counts.items(), key=lambda entry: (-entry[1], str(entry[0])))
    return Tally(
        counts=ordered[:MAX_TALLY_VALUES],
        distinct=len(ordered),
        truncated=len(ordered) > MAX_TALLY_VALUES,
    )


def _ranges(
    rows: Sequence[Dict[str, Any]], columns: Sequence[str]
) -> Dict[str, Tuple[Any, Any]]:
    ranges: Dict[str, Tuple[Any, Any]] = {}
    for column in columns:
        values = [row[column] for row in rows if row.get(column) is not None]
        if values:
            ranges[column] = (jsonable(min(values)), jsonable(max(values)))
    return ranges


def _row_count(storage: ObjectStorage, key: str) -> int:
    """One shard's row count, from its footer — no row is decoded."""
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    return pq.read_metadata(io.BytesIO(storage.get_object(key))).num_rows


def _schema_of(storage: ObjectStorage, key: str) -> List[Column]:
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    schema = pq.read_schema(io.BytesIO(storage.get_object(key)))
    return [Column(name=field.name, type=str(field.type)) for field in schema]


def _project(
    storage: ObjectStorage, key: str, columns: Sequence[str]
) -> List[Dict[str, Any]]:
    """One shard's rows for the named columns only, and never any other."""
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    table = pq.read_table(io.BytesIO(storage.get_object(key)), columns=list(columns))
    return table.to_pylist()
