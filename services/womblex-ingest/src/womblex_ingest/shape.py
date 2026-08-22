"""How big a corpus, run or document is — answered without reading it.

A client asks for shape so it can size a retrieval before making one: how many
elements this document holds, which kinds are in it, which printed pages it spans.
That is only worth asking if asking is cheaper than reading, so this module is
built around what Parquet lets you learn without decoding rows:

**Counts come from the footer, and only the footer crosses the wire.** A Parquet
file keeps its row count and schema in a footer at the end of the file, so sizing
a shard fetches the file's tail (`get_object_tail`) rather than its body and parses
that. Decoding the shard would be the obvious implementation and is the wrong one:
it reads no rows but still transfers every byte, which is the cost this whole
module exists to avoid. A corpus- or run-scope shape therefore costs one ranged
read per shard file, whatever the run holds.

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
    corpus_prefix,
    identity_candidates,
    jsonable,
    select_runs,
    select_shard_keys,
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

# How much of a shard's tail to fetch when sizing it. Big enough that one ranged
# read almost always carries the whole footer, small enough that it stays a
# rounding error against the shard itself.
FOOTER_TAIL_BYTES = 65536


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
    documents: Optional[int]
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
    # Listed once and threaded down. Selecting per (run, asset) instead would walk
    # the whole corpus prefix twelve times per run, which on a large bucket costs
    # more than every footer read put together.
    keys = storage.list_objects(corpus_prefix(corpus_id))
    wanted = [run for run in select_runs(keys) if run_id in (None, run.run_id)]
    runs = [
        _run_shape(
            storage,
            keys,
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
        documents=_corpus_documents(runs, scoped_to_one_run=run_id is not None),
        runs=runs,
    )


def _corpus_documents(runs: Sequence[RunShape], *, scoped_to_one_run: bool) -> Optional[int]:
    """How many documents the whole answer covers, where that can be said.

    `None` at corpus scope, deliberately. Runs of one corpus normally hold the
    same documents — a re-run is the ordinary case — so summing per-run counts
    reports a corpus of one document as two. Saying which documents are the *same*
    across runs means reading every run's identity column, which is exactly the
    cost that makes this call cheap enough to make first. The per-run counts below
    are the honest answer, and they are already there.
    """
    if not scoped_to_one_run:
        return None
    return sum(run.documents for run in runs)


def _run_shape(
    storage: ObjectStorage,
    keys: Sequence[str],
    run_id: str,
    versioned: bool,
    document_id: Optional[str],
    scoped_to_one_run: bool,
) -> RunShape:
    assets = [
        _asset_shape(
            storage,
            keys,
            run_id,
            asset,
            document_id,
            # A corpus scope asks which runs exist and how big each is, not what
            # shape their schemas are. Twelve assets' column lists are ~20KB of
            # payload that answers a question nobody asked at this scope, and the
            # run scope is one call away for a client that wants them.
            include_columns=scoped_to_one_run,
        )
        for asset in ASSETS.values()
    ]
    return RunShape(
        run_id=run_id,
        versioned=versioned,
        documents=_document_count(storage, keys, run_id, assets, document_id),
        assets=assets,
    )


def _document_count(
    storage: ObjectStorage,
    keys: Sequence[str],
    run_id: str,
    assets: Sequence[AssetShape],
    document_id: Optional[str],
) -> int:
    """How many documents this run's answer covers.

    Three ways, in order of cost. A document-scoped read asks the narrow question
    — "is this document in this run" — and any asset holding a row answers it. A
    run-scoped read reads the manifest's row count, because the manifest carries
    one row per document and that count is already in hand from its footer. Only
    when a run landed no manifest does this project an identity column, and then
    from the smallest asset present: a run whose elements hold documents but whose
    manifest was never written still holds them, and reporting nought beside a
    non-zero element count would be a contradiction a client cannot act on.
    """
    if document_id is not None:
        return 1 if any(asset.rows for asset in assets) else 0

    manifest = next(asset for asset in assets if asset.name == "manifest")
    if manifest.present:
        return manifest.rows or 0

    return len(_identity_values(storage, keys, run_id, assets))


def _identity_values(
    storage: ObjectStorage,
    keys: Sequence[str],
    run_id: str,
    assets: Sequence[AssetShape],
) -> set:
    """Distinct document ids in this run, projected from its smallest asset."""
    countable = [
        asset for asset in assets if asset.present and asset.readable and asset.rows
    ]
    if not countable:
        return set()

    smallest = min(countable, key=lambda asset: asset.rows or 0)
    definition = ASSETS[smallest.name]
    identity = [name for name in identity_candidates(definition) if name in _names(smallest)]
    if not identity:
        return set()

    found = set()
    for key in select_shard_keys(keys, run_id, definition):
        for row in _project(storage, key, identity[:1]):
            value = row.get(identity[0])
            if value is not None:
                found.add(value)
    return found


def _names(asset: AssetShape) -> set:
    return {column.name for column in asset.columns}


def _asset_shape(
    storage: ObjectStorage,
    keys: Sequence[str],
    run_id: str,
    asset: Asset,
    document_id: Optional[str],
    include_columns: bool,
) -> AssetShape:
    shard_keys = select_shard_keys(keys, run_id, asset)
    if not shard_keys:
        return _empty(asset, present=False)
    if not asset.readable:
        return _empty(asset, present=True)

    # One ranged read carries both the count and the schema, so the schema is
    # always known here even when it is not reported: a document scope needs it to
    # find the identity column, and deriving it from `include_columns` would make
    # an unreported schema silently mean "no columns" and every count nought.
    rows, columns = _footer(storage, shard_keys)
    reported = columns if include_columns else []
    if document_id is None:
        return AssetShape(
            name=asset.name,
            present=True,
            readable=True,
            rows=rows,
            columns=reported,
            values={},
            ranges={},
        )
    return _document_shape(storage, shard_keys, asset, columns, reported, document_id)


def _document_shape(
    storage: ObjectStorage,
    shard_keys: Sequence[str],
    asset: Asset,
    columns: List[Column],
    reported: List[Column],
    document_id: str,
) -> AssetShape:
    present = {column.name for column in columns}
    identity = [name for name in identity_candidates(asset) if name in present]
    if not identity:
        return AssetShape(asset.name, True, True, 0, reported, {}, {})

    tallied = [name for name in TALLY_COLUMNS.get(asset.name, ()) if name in present]
    ranged = [name for name in RANGE_COLUMNS.get(asset.name, ()) if name in present]
    projected = list(dict.fromkeys(identity + tallied + ranged))

    rows: List[Dict[str, Any]] = []
    for key in shard_keys:
        for row in _project(storage, key, projected):
            if any(row.get(column) == document_id for column in identity):
                rows.append(row)

    return AssetShape(
        name=asset.name,
        present=True,
        readable=True,
        rows=len(rows),
        columns=reported,
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


def _footer(storage: ObjectStorage, shard_keys: Sequence[str]) -> Tuple[int, List[Column]]:
    """One asset's row count and schema, from its shards' footers alone.

    The schema comes from the first shard even when it holds no rows — an empty
    asset must still report its columns, or a caller cannot tell "no rows" from
    "no such asset", and those two lead to opposite next actions.
    """
    rows = 0
    columns: List[Column] = []
    for key in shard_keys:
        metadata = _footer_metadata(storage, key)
        rows += metadata.num_rows
        if not columns:
            columns = [
                Column(name=field.name, type=str(field.type))
                for field in metadata.schema.to_arrow_schema()
            ]
    return rows, columns


def _footer_metadata(storage: ObjectStorage, key: str):
    """Parse a Parquet footer without fetching the shard.

    A Parquet file ends with its thrift-encoded metadata, then that block's length
    as four little-endian bytes, then the magic `PAR1`. Prefixing the block with
    the same magic makes a file pyarrow will parse: the row-group offsets inside
    it point past the end of what we fetched, but a row count and a schema need
    none of them. Reading the shard instead would decode no rows and still
    transfer every byte, which is the whole cost this avoids.
    """
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    tail = storage.get_object_tail(key, FOOTER_TAIL_BYTES)
    metadata_length = int.from_bytes(tail[-8:-4], "little")
    needed = metadata_length + 8
    footer = tail[-needed:] if needed <= len(tail) else storage.get_object_tail(key, needed)
    return pq.read_metadata(io.BytesIO(b"PAR1" + footer))


def _project(
    storage: ObjectStorage, key: str, columns: Sequence[str]
) -> List[Dict[str, Any]]:
    """One shard's rows for the named columns only, and never any other."""
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    table = pq.read_table(io.BytesIO(storage.get_object(key)), columns=list(columns))
    return table.to_pylist()
