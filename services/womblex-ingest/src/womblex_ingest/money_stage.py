"""Item 1 — invoke womblex's `money` stage over the shards in object storage.

`womblex money --shards` runs over a *local* directory; the distributed lane's
shards live in object storage under `proc/{evaluationId}/.../documents/`. This
module is the stage-in / run / stage-out / load step that bridges that gap,
mirroring womblex's own `finalize` (`cli/cloud.py`): download the money-stage
inputs to a scratch dir, run womblex's `money_shards()` over it, publish the two
`*.money_spans.parquet` / `*.money_columns.parquet` siblings back beside the
shards they annotate, and land the spans in `redline_money_spans`
(`money_span_store.py`) so the grid and the report tools can read them.

It is deliberately *not* part of `womblex run` / `worker`: the money op is
offline, API-free and has no ordering dependency on the pipeline, so it runs once
after the fleet has drained (the same lifecycle as `finalize`). The recognition
is entirely womblex's — this module owns only the object-storage plumbing, so it
stays behind the same `RemoteStore` seam ADR-0002 confines remote knowledge to.

`womblex` and its `RemoteStore` are imported lazily so the base sidecar package
installs (and the stub lane runs) without the engine; both are pulled by the
`.[womblex]` extra and only touched on the real lane.
"""

from __future__ import annotations

import argparse
import logging
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Sequence

from womblex_ingest.money_span_store import (
    MONEY_SPANS_SUFFIX,
    MoneySpanStore,
    load_money_spans,
)
from womblex_ingest.storage import ObjectStorage

logger = logging.getLogger(__name__)

# The two shards the money stage reads (womblex `process/money_stage.py`), and the
# two it writes. Only the inputs are staged in; the outputs are staged back out.
_ELEMENTS_SUFFIX = ".elements.parquet"
_TABLE_CELLS_SUFFIX = ".table_cells.parquet"
_MONEY_COLUMNS_SUFFIX = ".money_columns.parquet"
_MONEY_INPUT_SUFFIXES = (_ELEMENTS_SUFFIX, _TABLE_CELLS_SUFFIX)
# The spans suffix is the load path's, not this module's — one spelling, so the
# stage cannot publish under a name the loader does not glob for.
_MONEY_OUTPUT_SUFFIXES = (MONEY_SPANS_SUFFIX, _MONEY_COLUMNS_SUFFIX)


@dataclass(frozen=True)
class MoneyStageResult:
    """What one money run produced — surfaced so the caller can log it.

    Mirrors womblex's own `MoneyStageResult` field-for-field so a real run's
    return value maps straight through the seam.
    """

    batches_written: int
    spans_written: int
    columns_classified: int
    money_columns: int


class ShardPrefixEmpty(Exception):
    """Raised when no `*.elements.parquet` is present under the evaluation prefix.

    An empty run would masquerade as "annotated, found no money"; refusing makes a
    missing engine run diagnosable — the same posture `RealWomblexExtractor` takes
    for a missing shard prefix.
    """


# `money_shards(shard_dir) -> MoneyStageResult`. Injected in tests; on the real
# lane `_load_money_shards` binds womblex's own stage bound to redline's config.
MoneyShardsFn = Callable[[Path], MoneyStageResult]


def run_money_stage(
    storage: ObjectStorage,
    *,
    evaluation_id: str,
    money_shards: MoneyShardsFn | None = None,
    span_store: MoneySpanStore | None = None,
) -> MoneyStageResult:
    """Stage the money inputs down, annotate, publish the sidecars back, load the store.

    `storage` is the same `ObjectStorage` the sidecar writes shards through (it
    owns its own bucket), so the money run reads exactly the shards the womblex
    pod produced. `money_shards` defaults to womblex's own stage (real lane);
    tests inject a fake.

    `span_store` is the fourth step and the reason the annotation is worth running:
    a published sidecar nothing reads leaves `redline_money_spans` empty, which is
    invisible downstream — every consumer degrades to "no costing extracted".
    The load happens here, off the scratch dir the stage just wrote, rather than in
    a second pass that would re-download what is already on disk. It is present
    only when a deployment wired a DSN; without one the sidecars are still
    published and the store step is skipped, matching the chunk store's posture.
    """
    prefix = f"proc/{evaluation_id}/documents/"
    keys = storage.list_objects(prefix)
    input_keys = [k for k in keys if k.endswith(_MONEY_INPUT_SUFFIXES)]
    if not any(k.endswith(_ELEMENTS_SUFFIX) for k in input_keys):
        raise ShardPrefixEmpty(
            f"no {_ELEMENTS_SUFFIX} under {prefix!r}: run the womblex pod (the "
            "`womblex` compose profile) for this evaluation before annotating money"
        )

    stage = money_shards if money_shards is not None else _load_money_shards()

    with tempfile.TemporaryDirectory(prefix="redline-money-") as tmp:
        shard_dir = Path(tmp)
        _stage_in(storage, input_keys, shard_dir)
        result = stage(shard_dir)
        published = _stage_out(storage, prefix, shard_dir)
        loaded = 0 if span_store is None else load_money_spans(span_store, evaluation_id, shard_dir)

    logger.info(
        "money stage: evaluation=%s wrote %d amount(s) over %d column(s) "
        "(%d money) -> %d sidecar(s) under %s, %d span(s) loaded into the store",
        evaluation_id, result.spans_written, result.columns_classified,
        result.money_columns, len(published), prefix, loaded,
    )
    return result


def _stage_in(storage: ObjectStorage, input_keys: List[str], shard_dir: Path) -> None:
    for key in input_keys:
        (shard_dir / key.rsplit("/", 1)[-1]).write_bytes(storage.get_object(key))


def _stage_out(storage: ObjectStorage, prefix: str, shard_dir: Path) -> List[str]:
    published: List[str] = []
    for sidecar in sorted(shard_dir.iterdir()):
        if not sidecar.name.endswith(_MONEY_OUTPUT_SUFFIXES):
            continue
        key = f"{prefix}{sidecar.name}"
        storage.put_object(key, sidecar.read_bytes(), "application/octet-stream")
        published.append(key)
    return published


def _load_money_shards() -> MoneyShardsFn:
    """Bind womblex's real money stage to redline's config. Imports womblex.

    The `money:` section (vocabulary, vetoes, currency default) is sourced from
    the same config the womblex worker runs with, mounted at
    `infra/womblex/redline.yaml`, so redline never restates the engine's tuning.
    """
    import os

    from womblex.config import MoneyConfig, load_config
    from womblex.process.money_stage import money_shards as engine_money_shards

    config_path = os.environ.get("WOMBLEX_CONFIG")
    if config_path:
        loaded = load_config(Path(config_path))
        config, text_source = loaded.money, loaded.processing.text_source
    else:
        config, text_source = MoneyConfig(), "elements"

    def run(shard_dir: Path) -> MoneyStageResult:
        engine_result = engine_money_shards(shard_dir, config, text_source=text_source)
        return MoneyStageResult(
            batches_written=engine_result.batches_written,
            spans_written=engine_result.spans_written,
            columns_classified=engine_result.columns_classified,
            money_columns=engine_result.money_columns,
        )

    return run


# --- CLI entrypoint ----------------------------------------------------------
#
# Runnable on demand after the pipeline drains, the same lifecycle as
# `womblex finalize` (`compose run --rm womblex-ingest python -m
# womblex_ingest.money_stage --evaluation-id <id>`). The money op is offline and
# API-free, so this needs no Isaacus key.

# `() -> ObjectStorage`. Injected in tests; `_build_storage_from_env` binds the
# real S3 writer from the same `Settings` the sidecar starts with.
BuildStorageFn = Callable[[], ObjectStorage]

# `() -> MoneySpanStore | None`. Injected in tests; `_build_span_store_from_env`
# binds the real Postgres writer when a DSN is configured.
BuildSpanStoreFn = Callable[[], Optional[MoneySpanStore]]


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    build_storage: Optional[BuildStorageFn] = None,
    money_shards: MoneyShardsFn | None = None,
    build_span_store: Optional[BuildSpanStoreFn] = None,
) -> int:
    """Run the money stage for one evaluation; return a process exit code."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = _parse_args(argv)
    storage_builder = build_storage if build_storage is not None else _build_storage_from_env
    storage = storage_builder()
    span_store_builder = (
        build_span_store if build_span_store is not None else _build_span_store_from_env
    )

    try:
        run_money_stage(
            storage,
            evaluation_id=args.evaluation_id,
            money_shards=money_shards,
            span_store=span_store_builder(),
        )
    except ShardPrefixEmpty as empty:
        logger.error("%s", empty)
        return 1
    return 0


def _parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="womblex_ingest.money_stage",
        description="Annotate monetary amounts over an evaluation's womblex shards "
        "in object storage (stage-in, run `womblex money`, stage-out).",
    )
    parser.add_argument(
        "--evaluation-id", required=True,
        help="Evaluation whose shards under proc/<id>/documents/ to annotate.",
    )
    return parser.parse_args(argv)


def _build_storage_from_env() -> ObjectStorage:
    from womblex_ingest.config import Settings
    from womblex_ingest.storage import S3ObjectStorage

    settings = Settings.from_env()
    return S3ObjectStorage(
        endpoint_url=settings.s3_endpoint,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        bucket=settings.bucket,
    )


def _build_span_store_from_env() -> Optional[MoneySpanStore]:
    """The Postgres span writer, or ``None`` when no DSN is configured.

    The table is created by redline-adapters' migrations (it holds a foreign key to
    `redline_evaluations`), so unlike the chunk store there is nothing to migrate
    here — a missing table is a deployment that has not run its migrations, and
    failing loudly on the first insert is the right answer to that.
    """
    from womblex_ingest.config import Settings
    from womblex_ingest.money_span_store_postgres import PostgresMoneySpanStore

    settings = Settings.from_env()
    if not settings.redline_database_url:
        return None
    return PostgresMoneySpanStore(settings.redline_database_url)


if __name__ == "__main__":  # pragma: no cover - process entrypoint
    sys.exit(main())


__all__ = [
    "MoneyStageResult",
    "MoneyShardsFn",
    "ShardPrefixEmpty",
    "main",
    "run_money_stage",
]
