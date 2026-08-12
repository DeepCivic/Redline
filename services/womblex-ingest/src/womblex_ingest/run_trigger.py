"""Run trigger + run-status: the second engine seam (architecture §3/§5).

Object storage was redline's only coupling to the womblex engine — it wrote
shards, the sidecar read them. This module adds the second seam: a trigger into
the engine's job queue and a read of run state, so a browser reaches a run
without a terminal driving `enqueue` / `worker` / `run-stage` by hand.

`RunTrigger` is a *thin runner*, not an orchestrator. It fires the fixed sequence
the seed script's operator fires by hand — extraction (`enqueue` then `worker`),
then `run-stage --stage {chunk,embed,enrich}` in the caller-authored order, then
`money` — against the UI-authored config. It never reimplements batching, retry
or scale-out: those stay the engine's (`cloud/worker.py`, the Postgres queue). It
drives and observes.

The four operations it wraps are injected as callables (the `money_stage.py`
posture), so the sequencing logic runs in tests without a live Postgres, a real
womblex or an Isaacus key. `run_trigger_from_env` binds them to the real engine.

Run state is in-memory and process-local, like the ingest `RunRegistry`: a run's
durable record is its shards in MinIO and its `womblex_jobs` rows, not this. The
status a poller reads layers the current downstream stage on top of the queue's
own extraction stats, because `womblex_jobs` tracks extraction batches only.
"""

from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Literal, Optional

logger = logging.getLogger(__name__)

# The allow-listed downstream stages a form may author (architecture §2.1). The
# structural stages (`link`, `pii`, `normalise`, …) are not run parameters, so a
# request naming one is refused rather than fired.
ALLOWED_STAGES = ("chunk", "embed", "enrich", "money")

# Enforced dependency ordering: a stage that depends on another must run after
# it, whatever order the request authored. Only `embed` needs `chunk`; `enrich`
# and `money` are independent, so they keep their authored position after the
# chunk/embed pair is normalised.
_STAGE_RANK = {"chunk": 0, "embed": 1, "enrich": 2, "money": 3}

RunPhase = Literal["extracting", "staging", "done", "errored"]

# The four engine operations, injected so the sequencing logic is testable. Each
# receives the run id (the queue key) and the evaluation id (which scopes the
# object-store prefixes the real binding computes: `proc/{evaluationId}/inputs`
# for input, `proc/{evaluationId}/runs/{run_id}` for output).
# `enqueue(run_id, evaluation_id) -> batches inserted`; `run_worker(...)` drains
# them; `run_stage(run_id, evaluation_id, stage)` runs one downstream pass and
# raises `StageError` on a failed pass; `stats(run_id)` is the queue's own
# status reduction (run-scoped, so it needs only the run id).
EnqueueFn = Callable[[str, str], int]
RunWorkerFn = Callable[[str, str], None]
RunStageFn = Callable[[str, str, str], None]
StatsFn = Callable[[str], Dict[str, int]]


class UnknownStage(Exception):
    """A requested stage is not in the authorable allow-list."""


class StageError(Exception):
    """A downstream `run-stage` pass failed (a batch exhausted its retries).

    Carries the stage so the status read can name which pass of the sequence
    failed — `womblex_jobs` tracks extraction only, so the current stage is
    layered on top of it here.
    """

    def __init__(self, stage: str, message: str) -> None:
        self.stage = stage
        super().__init__(message)


@dataclass
class RunPlan:
    """One run to fire: which evaluation, and which downstream stages to run.

    `stage_sequence` is the allow-listed override (blank inherits the default at
    the surface above); the trigger normalises its ordering, it does not accept it
    verbatim.
    """

    evaluation_id: str
    stage_sequence: List[str]


@dataclass
class _RunState:
    run_id: str
    evaluation_id: str
    sequence: List[str]
    phase: RunPhase = "extracting"
    completed_stages: List[str] = field(default_factory=list)
    failed_stage: Optional[str] = None
    error: Optional[str] = None


def normalise_sequence(stage_sequence: List[str]) -> List[str]:
    """Validate against the allow-list and order by the enforced dependency.

    Raises `UnknownStage` for an off-list stage. Duplicates collapse — a stage
    runs at most once per sequence. The sort is stable on `_STAGE_RANK`, so
    `[embed, chunk]` becomes `[chunk, embed]` while an already-valid order is
    unchanged.
    """
    seen: List[str] = []
    for stage in stage_sequence:
        if stage not in ALLOWED_STAGES:
            raise UnknownStage(
                f"{stage!r} is not authorable; allowed stages are "
                f"{', '.join(ALLOWED_STAGES)}"
            )
        if stage not in seen:
            seen.append(stage)
    return sorted(seen, key=lambda stage: _STAGE_RANK[stage])


class RunTrigger:
    def __init__(
        self,
        *,
        enqueue: EnqueueFn,
        run_worker: RunWorkerFn,
        run_stage: RunStageFn,
        stats: StatsFn,
        run_in_background: bool = True,
    ) -> None:
        self._enqueue = enqueue
        self._run_worker = run_worker
        self._run_stage = run_stage
        self._stats = stats
        self._run_in_background = run_in_background
        self._runs: Dict[str, _RunState] = {}
        self._lock = threading.Lock()

    def start(self, plan: RunPlan) -> dict:
        """Begin a run: validate the sequence, then fire extraction + stages."""
        sequence = normalise_sequence(plan.stage_sequence)
        run_id = str(uuid.uuid4())
        state = _RunState(
            run_id=run_id, evaluation_id=plan.evaluation_id, sequence=sequence
        )
        with self._lock:
            self._runs[run_id] = state
        self._fire(state)
        return {"runId": run_id, "evaluationId": plan.evaluation_id}

    def resume(self, run_id: str) -> dict:
        """Re-fire the same run — done work skips, work picks up where it stopped.

        Resume is not its own path: womblex's `enqueue` is idempotent on
        `(run_id, batch_num)` and completed `run-stage` bases skip on their
        published outputs, so re-firing the identical sequence redoes nothing that
        finished. Completed stages are cleared here so a resumed run's status
        reflects the fresh pass; the engine, not this counter, decides what reruns.
        """
        with self._lock:
            state = self._runs[run_id]
            state.phase = "extracting"
            state.completed_stages = []
            state.failed_stage = None
            state.error = None
        self._fire(state)
        return {"runId": run_id, "evaluationId": state.evaluation_id}

    def status(self, run_id: str) -> dict:
        """The run's state as a view a poller binds to. Raises `KeyError` if absent."""
        with self._lock:
            state = self._runs[run_id]
            view_phase = state.phase
            evaluation_id = state.evaluation_id
            completed = list(state.completed_stages)
            failed_stage = state.failed_stage
            error = state.error
        extraction = self._stats(run_id)
        return {
            "runId": run_id,
            "evaluationId": evaluation_id,
            "phase": view_phase,
            "extraction": extraction,
            "completedStages": completed,
            "failedStage": failed_stage,
            # Every failure is resumable: idempotent enqueue + skip-on-output mean
            # re-firing the run is safe, so a failed stage always offers resume.
            "resumable": view_phase == "errored",
            "error": error,
        }

    def _fire(self, state: _RunState) -> None:
        if self._run_in_background:
            thread = threading.Thread(
                target=self._run, args=(state,), name=f"womblex-run-{state.run_id}", daemon=True
            )
            thread.start()
            return
        self._run(state)

    def _run(self, state: _RunState) -> None:
        try:
            self._enqueue(state.run_id, state.evaluation_id)
            self._run_worker(state.run_id, state.evaluation_id)
            with self._lock:
                state.phase = "staging"
            for stage in state.sequence:
                self._run_stage(state.run_id, state.evaluation_id, stage)
                with self._lock:
                    state.completed_stages.append(stage)
            with self._lock:
                state.phase = "done"
        except StageError as stage_error:
            logger.warning("run %s failed at stage %s: %s",
                           state.run_id, stage_error.stage, stage_error)
            with self._lock:
                state.phase = "errored"
                state.failed_stage = stage_error.stage
                state.error = str(stage_error)
        except Exception as run_error:  # extraction / infra failure
            logger.exception("run %s failed", state.run_id)
            with self._lock:
                state.phase = "errored"
                state.error = str(run_error)


# --- Real engine binding -----------------------------------------------------
#
# Binds the four injected callables to the actual womblex engine — the queue
# (`enqueue` / `worker` / `stats`) and the stage runner (`run-stage`). womblex is
# imported lazily (the `money_stage.py` posture) so the base sidecar package
# installs and the stub lane runs without the engine; these are touched only when
# a trigger is wired. Returns ``None`` when the DSN or store URI is absent, so the
# sidecar starts as a read-only seam and the /runs routes 503.


def run_trigger_from_env() -> Optional["RunTrigger"]:
    """Wire a `RunTrigger` to the real engine, or ``None`` if unconfigured."""
    from womblex_ingest.config import Settings

    settings = Settings.from_env()
    dsn = settings.womblex_db_dsn
    store_uri = settings.womblex_store_uri
    if not dsn or not store_uri:
        return None

    import os

    config_path = os.environ.get("WOMBLEX_CONFIG")
    return RunTrigger(
        enqueue=_engine_enqueue(dsn, store_uri, config_path),
        run_worker=_engine_run_worker(dsn, store_uri, config_path),
        run_stage=_engine_run_stage(dsn, store_uri, config_path),
        stats=_engine_stats(dsn),
    )


def _output_prefix(evaluation_id: str, run_id: str) -> str:
    # redline's bucket layout: the engine reads inputs the specialist staged
    # under `proc/{evaluationId}/inputs/` and publishes under this prefix, whose
    # `/documents/` child is the shard root every read seam globs.
    return f"proc/{evaluation_id}/runs/{run_id}"


def _input_prefix(evaluation_id: str) -> str:
    return f"proc/{evaluation_id}/inputs"


def _load_config(config_path: Optional[str]):  # type: ignore[no-untyped-def]
    from womblex.config import WomblexConfig, load_config
    from pathlib import Path

    if config_path:
        return load_config(Path(config_path))
    return WomblexConfig.model_validate(
        {"dataset": {"name": "redline"},
         "paths": {"input_root": ".", "output_root": ".", "checkpoint_dir": "."}}
    )


def _engine_enqueue(dsn: str, store_uri: str, config_path: Optional[str]) -> EnqueueFn:
    def enqueue(run_id: str, evaluation_id: str) -> int:
        from womblex.cloud.queue import JobQueue, JobSpec
        from womblex.store.remote import RemoteStore
        from womblex.cli._shared import SUPPORTED_EXTENSIONS
        from pathlib import Path

        config = _load_config(config_path)
        batch_size = config.processing.batch_size
        input_prefix = _input_prefix(evaluation_id)
        shard_prefix = f"{_output_prefix(evaluation_id, run_id)}/documents"

        store = RemoteStore.from_uri(store_uri)
        keys = sorted(
            key for key in store.list_files(input_prefix, "*")
            if Path(key).suffix.lower() in SUPPORTED_EXTENSIONS
        )
        if not keys:
            raise RuntimeError(
                f"no staged documents under {store_uri}/{input_prefix} — stage the "
                "corpus before triggering a run"
            )
        specs = [
            JobSpec(batch_num=index, input_keys=keys[start:start + batch_size],
                    shard_prefix=shard_prefix)
            for index, start in enumerate(range(0, len(keys), batch_size), start=1)
        ]
        with JobQueue(dsn) as queue:
            queue.ensure_schema()
            return queue.enqueue(run_id, specs)

    return enqueue


def _engine_run_worker(dsn: str, store_uri: str, config_path: Optional[str]) -> RunWorkerFn:
    def run_worker(run_id: str, evaluation_id: str) -> None:
        from womblex.cloud.worker import run_worker as engine_run_worker

        config = _load_config(config_path)
        # `once=False, idle_timeout` drains this run then exits — the single-shot
        # lifecycle the trigger drives. Scale-out (many workers) stays the
        # deployment's, unchanged: this fires exactly the operator's `worker` pass.
        engine_run_worker(dsn, store_uri, config, run_id=run_id, idle_timeout=1.0)

    return run_worker


def _engine_run_stage(dsn: str, store_uri: str, config_path: Optional[str]) -> RunStageFn:
    def run_stage(run_id: str, evaluation_id: str, stage: str) -> None:
        from womblex.cloud.stage_contracts import STAGE_CONTRACTS, RunContext
        from womblex.cloud.stage_runner import run_stage_remote
        from womblex.store.remote import RemoteStore
        from womblex.utils.availability import isaacus_available
        from womblex.utils.isaacus_client import make_isaacus_client

        contract = STAGE_CONTRACTS[stage]
        config = _load_config(config_path)
        if contract.preflight is not None:
            contract.preflight(config)
        ctx = RunContext()
        if contract.needs_isaacus_api and not isaacus_available():
            raise StageError(
                stage,
                f"{stage} needs Isaacus (ISAACUS_API_KEY); none is resolvable",
            )
        if contract.needs_client:
            ctx.client = make_isaacus_client(models=contract.models(config))
        shard_prefix = f"{_output_prefix(evaluation_id, run_id)}/documents"
        store = RemoteStore.from_uri(store_uri)
        summary = run_stage_remote(contract, store, shard_prefix, config, ctx=ctx)
        if summary.exit_code != 0:
            raise StageError(
                stage,
                f"{stage} pass failed: {summary.failed} failed, "
                f"{summary.not_ready} not-ready of {summary.bases} base(s)",
            )

    return run_stage


def _engine_stats(dsn: str) -> StatsFn:
    def stats(run_id: str) -> Dict[str, int]:
        from womblex.cloud.queue import JobQueue

        with JobQueue(dsn) as queue:
            return queue.stats(run_id)

    return stats


__all__ = [
    "ALLOWED_STAGES",
    "RunPlan",
    "RunTrigger",
    "StageError",
    "UnknownStage",
    "normalise_sequence",
    "run_trigger_from_env",
]
