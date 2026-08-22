"""The run-scoped, schema-carrying shard read.

This is the seam redline serves everything through. It reads one womblex run's
Parquet shards out of object storage and hands back the rows **with womblex's own
column names and values**, plus the schema they conform to.

Two properties it exists to hold, both of which the earlier per-document read
model gave up:

**Verbatim.** Column names are `source_hash`, `elem_order`, `parent_elem_order` —
not a camelCase read model of redline's invention. A client that reads redline's
names cannot join what it read back to the source, and cannot be pointed at
womblex's own documentation. Values are passed through untouched; the only
conversion is the one JSON forces (see `jsonable`), and it is exact.

**Run-scoped.** Several runs co-exist under one corpus prefix by design —
retention keeps the current run plus the previous. A read that spans them serves
every document once per run, and `elem_order` then identifies nothing. Every read
here names its run, so a client gets the same bytes tomorrow.

Nothing is derived here. Where redline computes a signal womblex did not write, it
belongs beside these rows under its own labelled key, never among them.

The schemas are recorded in `docs/Womblex-Output-Contract.md`. Read column names
from there rather than from memory — an earlier mapping invented `elem_order` /
`col_index` / `is_currency` on table cells and raised on every real row.
"""

from __future__ import annotations

import base64
import io
import math
import re
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Dict, List, Optional, Sequence, Tuple

from womblex_ingest.storage import ObjectStorage


class UnknownAsset(ValueError):
    """The caller named a shard family that does not exist."""


class AssetNotReadable(ValueError):
    """The asset exists but redline does not serve its rows."""


@dataclass(frozen=True)
class Asset:
    """One womblex shard family, addressed by the suffix its files carry.

    `identity_columns` is how a document filter finds its rows. Two spellings are
    in play and they carry the same value: the enrichment/graph shards key on
    `document_id`, every other family on `source_hash`. A caller holding one id
    must not have to know which spelling the asset it is reading happens to use.
    """

    name: str
    suffix: str
    identity_columns: Tuple[str, ...]
    readable: bool = True


_SOURCE_HASH = ("source_hash",)
_DOCUMENT_ID = ("document_id",)

ASSETS: Dict[str, Asset] = {
    asset.name: asset
    for asset in (
        Asset("elements", ".elements.parquet", _SOURCE_HASH),
        Asset("table_cells", ".table_cells.parquet", _SOURCE_HASH),
        Asset("form_fields", ".form_fields.parquet", _SOURCE_HASH),
        # The per-batch manifest sidecar, not the run-root `manifest.parquet` that
        # consolidates them — reading both would serve every document twice, which
        # is the same failure run-scoping exists to prevent, one level down.
        Asset("manifest", "._manifest.parquet", _SOURCE_HASH),
        Asset("chunks", ".chunks.parquet", _SOURCE_HASH),
        Asset("chunk_quality", ".chunk_quality.parquet", _SOURCE_HASH),
        Asset("money_spans", ".money_spans.parquet", _SOURCE_HASH),
        Asset("money_columns", ".money_columns.parquet", _SOURCE_HASH),
        Asset("entities", ".enrichment_entities.parquet", _DOCUMENT_ID),
        Asset("graph_edges", ".graph_edges.parquet", _DOCUMENT_ID),
        Asset("enrichment_meta", ".enrichment_meta.parquet", _DOCUMENT_ID),
        # Catalogued so a caller can see it exists, and refused so a caller cannot
        # drown in it: womblex ships no index, so nothing ranks these vectors, and
        # one document's worth dwarfs every other payload on this seam.
        Asset("embeddings", ".embeddings.parquet", _SOURCE_HASH, readable=False),
    )
}

# A run directory is `run-YYYYMMDDTHHMMSSZ`, sitting either directly under the
# corpus prefix (`<root>/<run_id>/documents/`, what the engine writes) or under a
# `runs/` segment when the store URI adds one. Both spellings resolve to the same
# run id — reading only one drops the other's shards into the unversioned bucket,
# where runs merge.
_RUN_SEGMENT = re.compile(r"(?:^|/)(?:runs/)?(run-[^/]+)/")

# Shards that carry no run directory at all: the pre-run-id layout. Surfaced under
# one reserved, addressable id rather than hidden, so a legacy corpus is still
# readable and still explicitly *not* a versioned run.
UNVERSIONED_RUN_ID = "_unversioned"

DEFAULT_LIMIT = 500


@dataclass(frozen=True)
class RunSummary:
    run_id: str
    versioned: bool
    shard_count: int


@dataclass(frozen=True)
class Column:
    name: str
    type: str


@dataclass(frozen=True)
class ShardPage:
    asset: str
    run_id: str
    columns: List[Column]
    rows: List[Dict[str, Any]]
    returned: int
    available: int
    truncated: bool

    def to_json(self) -> dict:
        return {
            "asset": self.asset,
            "runId": self.run_id,
            "columns": [{"name": c.name, "type": c.type} for c in self.columns],
            "rows": self.rows,
            "returned": self.returned,
            "available": self.available,
            "truncated": self.truncated,
        }


def corpus_prefix(corpus_id: str) -> str:
    return f"proc/{corpus_id}/"


def run_id_for_key(key: str) -> str:
    match = _RUN_SEGMENT.search(key)
    return match.group(1) if match else UNVERSIONED_RUN_ID


def list_runs(storage: ObjectStorage, corpus_id: str) -> List[RunSummary]:
    """Every run under the corpus prefix, newest first.

    Run ids sort lexically by creation order (`run-YYYYMMDDTHHMMSSZ`), which is
    how womblex's own `most_recent_run` picks the latest. The unversioned bucket
    sorts last: it is a legacy layout, never the newest thing a caller wants.
    """
    counts: Dict[str, int] = {}
    for key in storage.list_objects(corpus_prefix(corpus_id)):
        if not key.endswith(".parquet"):
            continue
        counts[run_id_for_key(key)] = counts.get(run_id_for_key(key), 0) + 1

    versioned = sorted((r for r in counts if r != UNVERSIONED_RUN_ID), reverse=True)
    ordered = versioned + ([UNVERSIONED_RUN_ID] if UNVERSIONED_RUN_ID in counts else [])
    return [
        RunSummary(
            run_id=run_id,
            versioned=run_id != UNVERSIONED_RUN_ID,
            shard_count=counts[run_id],
        )
        for run_id in ordered
    ]


def read_shard(
    storage: ObjectStorage,
    corpus_id: str,
    run_id: str,
    asset: str,
    *,
    document_id: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
    offset: int = 0,
) -> ShardPage:
    """One run's rows for one shard family, with the schema they conform to."""
    definition = ASSETS.get(asset)
    if definition is None:
        raise UnknownAsset(
            f"unknown asset {asset!r}; known assets are {', '.join(sorted(ASSETS))}"
        )
    if not definition.readable:
        raise AssetNotReadable(
            f"asset {asset!r} is catalogued but not served — womblex ships no index "
            "over these vectors, so nothing here can rank them"
        )

    keys = shard_keys(storage, corpus_id, run_id, definition)
    columns, rows = _decode(storage, keys)
    matching = _filter_by_document(rows, definition, document_id)

    window = matching[offset : offset + limit] if limit >= 0 else matching[offset:]
    return ShardPage(
        asset=asset,
        run_id=run_id,
        columns=columns,
        rows=window,
        returned=len(window),
        available=len(matching),
        truncated=offset + len(window) < len(matching),
    )


def identity_candidates(asset: Asset) -> Tuple[str, ...]:
    """Every column a document id may be matched against on this asset.

    Both identity spellings are accepted on every asset, not just the ones that
    declare them: they carry the same value, and a caller holding one id should
    not need to know which family it is reading.
    """
    return asset.identity_columns + _SOURCE_HASH + _DOCUMENT_ID


def shard_keys(
    storage: ObjectStorage, corpus_id: str, run_id: str, asset: Asset
) -> List[str]:
    """This run's shard keys for one asset, sorted so concatenation is stable."""
    return sorted(
        key
        for key in storage.list_objects(corpus_prefix(corpus_id))
        if key.endswith(asset.suffix) and run_id_for_key(key) == run_id
    )


def _decode(
    storage: ObjectStorage, keys: Sequence[str]
) -> Tuple[List[Column], List[Dict[str, Any]]]:
    """Decode every shard in key order, taking the schema from the first.

    The schema comes from the file even when it holds no rows — an empty asset
    must still report its columns, or a caller cannot tell "no rows" from "no
    such asset", and those two lead to opposite next actions.
    """
    columns: List[Column] = []
    rows: List[Dict[str, Any]] = []
    for key in keys:
        table = _read_parquet(storage.get_object(key))
        if not columns:
            columns = [Column(name=f.name, type=str(f.type)) for f in table.schema]
        rows.extend(jsonable(row) for row in table.to_pylist())
    return columns, rows


def _filter_by_document(
    rows: Sequence[Dict[str, Any]], asset: Asset, document_id: Optional[str]
) -> List[Dict[str, Any]]:
    if document_id is None:
        return list(rows)
    candidates = identity_candidates(asset)
    return [
        row
        for row in rows
        if any(row.get(column) == document_id for column in candidates)
    ]


def _read_parquet(body: bytes):
    """Decode one Parquet shard.

    pyarrow is imported here rather than at module scope so the asset catalogue
    and run discovery above stay importable without it.
    """
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    return pq.read_table(io.BytesIO(body))


def jsonable(value: Any) -> Any:
    """Narrow an Arrow-decoded value to something JSON can carry, exactly.

    The one conversion that matters: a `decimal128(38, 4)` becomes its **digit
    string**, never a float. A money span's `value` is exact by construction, and
    routing it through float64 silently rewrites amounts that decimal represents
    and binary floating point does not.
    """
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, dict):
        return {key: jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    # NaN and the infinities have no JSON spelling, and emitting them produces a
    # body a strict parser rejects — losing the whole read over one cell.
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value
