"""The Create Corpus programme's first seam: a run trigger + a run-status read.

This is the *second* engine seam (architecture §3/§5): until now object storage
was the only coupling to the womblex engine — it wrote shards, the sidecar read
them back. This adds a trigger into the engine's job queue and a read of its
state, so a browser "start run" reaches the engine without a terminal driving
`enqueue` / `worker` / `run-stage` by hand.

The trigger is a *thin runner*, not an orchestrator: it fires the fixed CLI
sequence the seed script's operator fires by hand — extraction (`enqueue` +
`worker`), then `run-stage --stage {chunk,embed,enrich}` in the caller-authored
order, then `money` — against the UI-authored config. Batching, retry and
scale-out stay the engine's (`cloud/worker.py`, the queue); this module drives
and observes, it does not reimplement them.

These tests inject fakes for the queue and the stage passes (the same
dependency-injection posture `money_stage.py` takes for `money_shards` /
`ObjectStorage`), so the sequencing logic itself is exercised without a live
Postgres, a real womblex or an Isaacus key. The passes are recorded in call
order so the enforced dependency (chunk before embed) is asserted, not assumed.
"""

from __future__ import annotations

import time
from typing import Dict, List

import pytest
from fastapi.testclient import TestClient

from womblex_ingest.main import build_app
from womblex_ingest.run_trigger import (
    RunPlan,
    RunTrigger,
    StageError,
    UnknownStage,
)
from tests.conftest import FakeObjectStorage, StubExtractor


class FakeQueue:
    """Stands in for `womblex.cloud.queue.JobQueue`, run-scoped by run id.

    `stats` is what a status read reduces the extraction phase to; the trigger
    layers the current downstream stage on top of it, because `womblex_jobs`
    tracks extraction batches only (architecture §2.1).
    """

    def __init__(self) -> None:
        self.enqueued: List[str] = []
        self.worker_runs: List[str] = []
        # run_id -> {status: count}
        self._stats: Dict[str, Dict[str, int]] = {}

    def set_stats(self, run_id: str, stats: Dict[str, int]) -> None:
        self._stats[run_id] = stats

    def enqueue(self, run_id: str, evaluation_id: str) -> int:
        self.enqueued.append(run_id)
        # One batch pending until a worker drains it.
        self._stats.setdefault(run_id, {"pending": 1})
        return 1

    def run_worker(self, run_id: str, evaluation_id: str) -> None:
        self.worker_runs.append(run_id)
        self._stats[run_id] = {"done": 1}

    def stats(self, run_id: str) -> Dict[str, int]:
        return dict(self._stats.get(run_id, {}))


class FakeStages:
    """Records each downstream `run-stage` pass, in call order."""

    def __init__(self) -> None:
        self.calls: List[str] = []
        self.fail_on: str | None = None

    def run(self, run_id: str, evaluation_id: str, stage: str) -> None:
        self.calls.append(stage)
        if stage == self.fail_on:
            raise StageError(stage, f"{stage} pass exhausted retries")


def _build(queue: FakeQueue, stages: FakeStages) -> RunTrigger:
    return RunTrigger(
        enqueue=queue.enqueue,
        run_worker=queue.run_worker,
        run_stage=stages.run,
        stats=queue.stats,
        # Run inline so the tests are deterministic — the production wiring runs
        # the passes on a background thread (a run is minutes-long, status polled).
        run_in_background=False,
    )


def _wait_terminal(trigger: RunTrigger, run_id: str) -> dict:
    for _ in range(200):
        view = trigger.status(run_id)
        if view["phase"] in ("done", "errored"):
            return view
        time.sleep(0.005)
    raise AssertionError("run did not reach a terminal phase")


DEFAULT_SEQUENCE = ["chunk", "embed", "enrich", "money"]


# --- Triggering the fixed sequence ------------------------------------------


def test_trigger_fires_extraction_then_the_downstream_stages_in_order() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)

    plan = RunPlan(evaluation_id="eval-1", stage_sequence=DEFAULT_SEQUENCE)
    started = trigger.start(plan)

    assert started["evaluationId"] == "eval-1"
    assert started["runId"]

    _wait_terminal(trigger, started["runId"])
    # Extraction is enqueue + worker, once, before any downstream stage.
    assert queue.enqueued == [started["runId"]]
    assert queue.worker_runs == [started["runId"]]
    # Downstream passes run in the authored order.
    assert stages.calls == DEFAULT_SEQUENCE


def test_trigger_honours_the_authored_stage_sequence() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)

    # A corpus with no priced schedule authors chunk+embed only (no money, no
    # enrich) — the allow-listed sequence override.
    plan = RunPlan(evaluation_id="eval-2", stage_sequence=["chunk", "embed"])
    started = trigger.start(plan)
    _wait_terminal(trigger, started["runId"])

    assert stages.calls == ["chunk", "embed"]


def test_trigger_enforces_chunk_before_embed_regardless_of_order() -> None:
    # The dependency (embed needs chunk) is the sidecar's to enforce, not the
    # specialist's to get right: an authored order that puts embed first is
    # normalised, never run as given.
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)

    plan = RunPlan(evaluation_id="eval-3", stage_sequence=["embed", "chunk"])
    started = trigger.start(plan)
    _wait_terminal(trigger, started["runId"])

    assert stages.calls == ["chunk", "embed"]


def test_trigger_rejects_a_stage_outside_the_allow_list() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)

    # `link`/`pii` are structural, not run parameters (architecture §2.1) — a form
    # cannot author them, so the trigger refuses rather than firing an off-list pass.
    with pytest.raises(UnknownStage):
        trigger.start(RunPlan(evaluation_id="eval-4", stage_sequence=["chunk", "link"]))


# --- Reading run state ------------------------------------------------------


def test_status_reports_started_running_and_done() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)

    started = trigger.start(RunPlan(evaluation_id="eval-5", stage_sequence=DEFAULT_SEQUENCE))
    view = _wait_terminal(trigger, started["runId"])

    assert view["phase"] == "done"
    assert view["evaluationId"] == "eval-5"
    # The extraction queue's own status reduction is surfaced under the run.
    assert view["extraction"] == {"done": 1}
    # A done run names every stage it completed.
    assert view["completedStages"] == DEFAULT_SEQUENCE
    assert view["error"] is None


def test_status_names_the_stage_that_failed_and_is_resumable() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    stages.fail_on = "embed"
    trigger = _build(queue, stages)

    started = trigger.start(RunPlan(evaluation_id="eval-6", stage_sequence=DEFAULT_SEQUENCE))
    view = _wait_terminal(trigger, started["runId"])

    assert view["phase"] == "errored"
    # A failed stage names itself and says why — never a spinner that never resolves.
    assert view["failedStage"] == "embed"
    assert "embed" in view["error"]
    # It is resumable: chunk completed, embed failed, later stages never ran.
    assert view["completedStages"] == ["chunk"]
    assert view["resumable"] is True
    # A stage after the failure must not have run.
    assert "enrich" not in stages.calls
    assert "money" not in stages.calls


def test_resume_re_fires_the_same_trigger_and_completed_stages_skip() -> None:
    # womblex's enqueue is idempotent on (run_id, batch_num) and completed
    # `run-stage` bases skip on their published outputs, so resume is re-firing
    # the same run id — done work is not redone, work picks up where it stopped.
    queue = FakeQueue()
    stages = FakeStages()
    stages.fail_on = "embed"
    trigger = _build(queue, stages)

    started = trigger.start(RunPlan(evaluation_id="eval-7", stage_sequence=DEFAULT_SEQUENCE))
    _wait_terminal(trigger, started["runId"])

    # The embed transient clears; resume the same run.
    stages.fail_on = None
    resumed = trigger.resume(started["runId"])
    assert resumed["runId"] == started["runId"]
    view = _wait_terminal(trigger, started["runId"])

    assert view["phase"] == "done"
    # The whole sequence is complete after the resume.
    assert view["completedStages"] == DEFAULT_SEQUENCE


def test_status_of_an_unknown_run_reports_not_found() -> None:
    trigger = _build(FakeQueue(), FakeStages())

    with pytest.raises(KeyError):
        trigger.status("no-such-run")


# --- HTTP surface (the two JSON endpoints redline's adapter calls) ----------
#
# `POST /runs` triggers a run for one evaluation; `GET /runs/{runId}` reads its
# state; `POST /runs/{runId}/resume` re-fires it. The adapter (redline-adapters)
# calls exactly these, so the wire shape is asserted here.


def _client(queue: FakeQueue, stages: FakeStages) -> TestClient:
    app = build_app(
        storage=FakeObjectStorage(),
        extractor=StubExtractor(),
        bucket="redline",
        run_trigger=_build(queue, stages),
    )
    return TestClient(app)


def test_post_runs_triggers_a_run_and_returns_its_id() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    client = _client(queue, stages)

    response = client.post(
        "/runs",
        json={"evaluationId": "eval-1", "stageSequence": DEFAULT_SEQUENCE},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["runId"]
    assert body["evaluationId"] == "eval-1"


def test_post_runs_rejects_an_off_list_stage() -> None:
    client = _client(FakeQueue(), FakeStages())

    response = client.post(
        "/runs",
        json={"evaluationId": "eval-1", "stageSequence": ["chunk", "link"]},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_post_runs_rejects_an_empty_evaluation_id() -> None:
    client = _client(FakeQueue(), FakeStages())

    response = client.post(
        "/runs", json={"evaluationId": "  ", "stageSequence": DEFAULT_SEQUENCE}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_get_run_reports_its_state() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    client = _client(queue, stages)

    run_id = client.post(
        "/runs", json={"evaluationId": "eval-2", "stageSequence": DEFAULT_SEQUENCE}
    ).json()["runId"]

    body = client.get(f"/runs/{run_id}").json()
    assert body["runId"] == run_id
    assert body["evaluationId"] == "eval-2"
    assert body["phase"] == "done"
    assert body["completedStages"] == DEFAULT_SEQUENCE


def test_get_unknown_run_is_404() -> None:
    client = _client(FakeQueue(), FakeStages())

    response = client.get("/runs/does-not-exist")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "RUN_NOT_FOUND"


def test_post_resume_re_fires_a_failed_run() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    stages.fail_on = "embed"
    client = _client(queue, stages)

    run_id = client.post(
        "/runs", json={"evaluationId": "eval-3", "stageSequence": DEFAULT_SEQUENCE}
    ).json()["runId"]
    assert client.get(f"/runs/{run_id}").json()["phase"] == "errored"

    stages.fail_on = None
    resume = client.post(f"/runs/{run_id}/resume")
    assert resume.status_code == 202
    assert client.get(f"/runs/{run_id}").json()["phase"] == "done"


def test_post_resume_of_unknown_run_is_404() -> None:
    client = _client(FakeQueue(), FakeStages())

    response = client.post("/runs/does-not-exist/resume")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "RUN_NOT_FOUND"
