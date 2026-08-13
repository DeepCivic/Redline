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

import copy
import time
from typing import Dict, List

import pytest
from fastapi.testclient import TestClient

from womblex_ingest.main import build_app
from womblex_ingest.run_trigger import (
    ChunkModeOverride,
    ConfigOverride,
    ExtractionOverride,
    MoneyVocabularyOverride,
    RunPlan,
    RunTrigger,
    StageError,
    UnsupportedOverride,
    UnknownStage,
    apply_config_override,
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
        self.worker_overrides: List[ConfigOverride | None] = []
        # run_id -> {status: count}
        self._stats: Dict[str, Dict[str, int]] = {}

    def set_stats(self, run_id: str, stats: Dict[str, int]) -> None:
        self._stats[run_id] = stats

    def enqueue(self, run_id: str, evaluation_id: str) -> int:
        self.enqueued.append(run_id)
        # One batch pending until a worker drains it.
        self._stats.setdefault(run_id, {"pending": 1})
        return 1

    def run_worker(
        self,
        run_id: str,
        evaluation_id: str,
        override: ConfigOverride | None = None,
    ) -> None:
        self.worker_runs.append(run_id)
        # Extraction is the only pass that reads `extraction.ocr.*`, so the
        # override has to reach the worker — recording it is how the extraction
        # half of the allow-list is proven, the way `FakeStages` proves the
        # downstream half.
        self.worker_overrides.append(override)
        self._stats[run_id] = {"done": 1}

    def stats(self, run_id: str) -> Dict[str, int]:
        return dict(self._stats.get(run_id, {}))


class FakeStages:
    """Records each downstream `run-stage` pass, in call order."""

    def __init__(self) -> None:
        self.calls: List[str] = []
        self.overrides: List[ConfigOverride | None] = []
        self.fail_on: str | None = None

    def run(
        self,
        run_id: str,
        evaluation_id: str,
        stage: str,
        override: ConfigOverride | None = None,
    ) -> None:
        self.calls.append(stage)
        self.overrides.append(override)
        if stage == self.fail_on:
            raise StageError(stage, f"{stage} pass exhausted retries")


class FakeLoader:
    """Stands in for the shard→`redline_chunks` projection the load step drives.

    Records each `(run_id, evaluation_id)` it was asked to project so the exit
    test can assert a done run drove the same load `POST /ingest` drives — the
    join that makes the corpus visible to `IStagedCorpusReader`. `fail` raises,
    standing in for a store write that failed, so the loud-failure path is proven.
    """

    def __init__(self) -> None:
        self.calls: List[tuple[str, str]] = []
        self.fail = False

    def load(self, run_id: str, evaluation_id: str) -> None:
        self.calls.append((run_id, evaluation_id))
        if self.fail:
            raise RuntimeError("redline_chunks projection failed")


def _build(
    queue: FakeQueue, stages: FakeStages, loader: FakeLoader | None = None
) -> RunTrigger:
    return RunTrigger(
        enqueue=queue.enqueue,
        run_worker=queue.run_worker,
        run_stage=stages.run,
        stats=queue.stats,
        load=(loader or FakeLoader()).load,
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


# --- Loading the run's own shards (the two-screen join) ----------------------
#
# A finished run must project its published shards into `redline_chunks` — the
# same load `POST /ingest` drives — or the corpus it produced is visible to no
# screen and the two-screen flow has no join (delivery-plan §, cold start step 1).


def test_a_done_run_loads_its_own_shards_after_the_stages() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    loader = FakeLoader()
    trigger = _build(queue, stages, loader)

    started = trigger.start(RunPlan(evaluation_id="eval-8", stage_sequence=DEFAULT_SEQUENCE))
    view = _wait_terminal(trigger, started["runId"])

    assert view["phase"] == "done"
    # The load ran once, scoped to this run + evaluation, so the corpus the run
    # published is now readable by IStagedCorpusReader — no POST /ingest between.
    assert loader.calls == [(started["runId"], "eval-8")]


def test_the_load_runs_after_every_stage_has_completed() -> None:
    # The projection reads the shards the downstream stages published, so it must
    # run only once they have all completed — never interleaved with them.
    queue = FakeQueue()
    stages = FakeStages()
    loader = FakeLoader()
    trigger = _build(queue, stages, loader)

    started = trigger.start(RunPlan(evaluation_id="eval-9", stage_sequence=DEFAULT_SEQUENCE))
    _wait_terminal(trigger, started["runId"])

    assert stages.calls == DEFAULT_SEQUENCE
    assert loader.calls == [(started["runId"], "eval-9")]


def test_a_stage_failure_skips_the_load() -> None:
    # A run that never finished its stages has no complete corpus to project;
    # loading a half-run's shards would land a partial, misleading corpus.
    queue = FakeQueue()
    stages = FakeStages()
    stages.fail_on = "embed"
    loader = FakeLoader()
    trigger = _build(queue, stages, loader)

    started = trigger.start(RunPlan(evaluation_id="eval-10", stage_sequence=DEFAULT_SEQUENCE))
    view = _wait_terminal(trigger, started["runId"])

    assert view["phase"] == "errored"
    assert loader.calls == []


def test_a_load_failure_fails_the_run_loudly() -> None:
    # The projection is the point of the step: a store write that failed must fail
    # the run, not leave a done run whose corpus never reached redline_chunks.
    queue = FakeQueue()
    stages = FakeStages()
    loader = FakeLoader()
    loader.fail = True
    trigger = _build(queue, stages, loader)

    started = trigger.start(RunPlan(evaluation_id="eval-11", stage_sequence=DEFAULT_SEQUENCE))
    view = _wait_terminal(trigger, started["runId"])

    assert view["phase"] == "errored"
    assert "projection failed" in view["error"]
    # Every stage completed; the failure is the load, not a stage — resumable.
    assert view["completedStages"] == DEFAULT_SEQUENCE
    assert view["resumable"] is True


def test_resume_after_a_load_failure_re_runs_the_load() -> None:
    # The store transient clears; resume re-fires the run and the projection
    # lands. Idempotent upserts keep re-loading the same shards safe.
    queue = FakeQueue()
    stages = FakeStages()
    loader = FakeLoader()
    loader.fail = True
    trigger = _build(queue, stages, loader)

    started = trigger.start(RunPlan(evaluation_id="eval-12", stage_sequence=DEFAULT_SEQUENCE))
    _wait_terminal(trigger, started["runId"])

    loader.fail = False
    trigger.resume(started["runId"])
    view = _wait_terminal(trigger, started["runId"])

    assert view["phase"] == "done"
    # Two attempts at the projection: the failed pass, then the resumed pass.
    assert loader.calls == [
        (started["runId"], "eval-12"),
        (started["runId"], "eval-12"),
    ]


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


# --- The authored config override reaches the engine -------------------------
#
# The form composes the allow-listed override, `makeRunConfigOverride` validates
# it and `HttpWomblexRunTrigger` puts it on the wire — and until this seam
# carried it, pydantic discarded the extra key without complaint and every run
# used the redline.yaml default. Silently ignoring an override a specialist typed
# is worse than refusing it, so these prove it arrives and is applied.


class StubColumns:
    """Mirrors `womblex.config.MoneyColumnsConfig`'s two term lists.

    The real shape was verified against the pinned engine (0.4.0, d6850de):
    `extra_header_terms` / `extra_veto_terms` hang off `MoneyColumnsConfig`, not
    off `MoneyConfig` — an override written from the short names would set them
    one level too high and silently do nothing.
    """

    def __init__(self) -> None:
        self.extra_header_terms: List[str] = []
        self.extra_veto_terms: List[str] = []


class StubChunking:
    def __init__(self) -> None:
        self.chunk_size = 480
        self.chunk_tables = True
        self.chunking_model = None


class StubMoney:
    def __init__(self) -> None:
        self.default_currency = "AUD"
        self.columns = StubColumns()


class StubOcrSettings:
    def __init__(self) -> None:
        self.engine = "paddleocr"
        self.dpi = 300


class StubExtractionSettings:
    """Mirrors `womblex.config.ExtractionConfig` — the `ocr` half of it.

    `extraction.native.include_tables` is deliberately absent: the pinned engine
    (0.4.0, d6850de) never reads that field — `run_extraction` threads only
    `ocr.dpi`, `ocr.lang`, `ocr.engine`, `ocr.engine_options` and
    `native.spreadsheet_print` into `extract_text`. An override for it would be a
    knob that does nothing.
    """

    def __init__(self) -> None:
        self.ocr = StubOcrSettings()


class StubConfig:
    """Stands in for `WomblexConfig` — only the keys the allow-list can reach."""

    def __init__(self) -> None:
        self.chunking = StubChunking()
        self.money = StubMoney()
        self.extraction = StubExtractionSettings()

    def model_copy(self, deep: bool = False) -> "StubConfig":
        return copy.deepcopy(self)


def test_a_blank_override_leaves_the_file_default_untouched() -> None:
    config = StubConfig()

    applied = apply_config_override(config, None)

    assert applied is config
    assert applied.chunking.chunk_size == 480
    assert applied.money.default_currency == "AUD"


def test_chunk_mode_override_sets_size_and_tables_on_a_copy() -> None:
    config = StubConfig()
    override = ConfigOverride(
        chunk_mode=ChunkModeOverride(chunk_size=640, chunk_tables=False)
    )

    applied = apply_config_override(config, override)

    assert applied.chunking.chunk_size == 640
    assert applied.chunking.chunk_tables is False
    # The loaded file config is never mutated: a second run in the same process
    # must not inherit the first run's overrides.
    assert config.chunking.chunk_size == 480
    assert config.chunking.chunk_tables is True


def test_money_vocabulary_override_reaches_the_columns_config() -> None:
    config = StubConfig()
    override = ConfigOverride(
        money_vocabulary=MoneyVocabularyOverride(
            extra_header_terms=["schedule of rates"],
            extra_veto_terms=["page"],
            default_currency="NZD",
        )
    )

    applied = apply_config_override(config, override)

    assert applied.money.columns.extra_header_terms == ["schedule of rates"]
    assert applied.money.columns.extra_veto_terms == ["page"]
    assert applied.money.default_currency == "NZD"
    assert config.money.columns.extra_header_terms == []


# --- The extraction group ----------------------------------------------------
#
# `redline.yaml` marks `extraction.ocr.engine: paddleocr` LOAD-BEARING: only
# region-based engines supply the per-detection quads table-cell reconstruction
# bins into rows and columns, so a VLM engine returns markdown with no regions
# and deletes every table cell on a scanned page — which is where a scanned
# tender keeps its pricing. That makes it the setting a first run most needs to
# reach, and a first run has nothing to orphan by changing it.


def test_extraction_override_sets_the_ocr_engine_and_dpi_on_a_copy() -> None:
    config = StubConfig()
    override = ConfigOverride(
        extraction=ExtractionOverride(ocr_engine="mistral-ocr", ocr_dpi=400)
    )

    applied = apply_config_override(config, override)

    assert applied.extraction.ocr.engine == "mistral-ocr"
    assert applied.extraction.ocr.dpi == 400
    # The loaded file config is never mutated — the same rule the other groups keep.
    assert config.extraction.ocr.engine == "paddleocr"
    assert config.extraction.ocr.dpi == 300


def test_an_unset_extraction_field_inherits_rather_than_nulling() -> None:
    config = StubConfig()
    override = ConfigOverride(extraction=ExtractionOverride(ocr_engine="ollama"))

    applied = apply_config_override(config, override)

    assert applied.extraction.ocr.engine == "ollama"
    # dpi was not authored, so it keeps the file's 300 rather than becoming None.
    assert applied.extraction.ocr.dpi == 300


def test_the_worker_runs_extraction_against_the_authored_override() -> None:
    # Extraction is `enqueue` + `worker`, and the worker is the only pass that
    # reads `extraction.ocr.*`. An override that reached the downstream stages
    # but not the worker would leave the engine setting inert — the silent drop
    # this seam exists to close.
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)
    override = ConfigOverride(
        extraction=ExtractionOverride(ocr_engine="mistral-ocr", ocr_dpi=400)
    )

    started = trigger.start(
        RunPlan(
            evaluation_id="eval-ocr",
            stage_sequence=["chunk"],
            config_override=override,
        )
    )
    _wait_terminal(trigger, started["runId"])

    assert queue.worker_overrides == [override]


def test_a_run_with_no_override_passes_none_to_the_worker() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)

    started = trigger.start(
        RunPlan(evaluation_id="eval-worker-default", stage_sequence=["chunk"])
    )
    _wait_terminal(trigger, started["runId"])

    assert queue.worker_overrides == [None]


def test_an_unset_field_within_a_group_inherits_rather_than_nulling() -> None:
    config = StubConfig()
    override = ConfigOverride(chunk_mode=ChunkModeOverride(chunk_size=320))

    applied = apply_config_override(config, override)

    assert applied.chunking.chunk_size == 320
    # chunk_tables was not authored, so it keeps the file's value rather than
    # becoming None — a blank field inherits, it does not clear.
    assert applied.chunking.chunk_tables is True


# `WomblexConfig._wire_ai_chunking_reuse` auto-enables enrichment.persist_document
# when chunking_model is set, and warns that enrich must run BEFORE chunk or the
# document is enriched twice, at double API cost. The Create Corpus stage toggles
# cannot express that ordering — the sidecar normalises chunk before embed and
# leaves enrich where it was authored — so a specialist ticking an AI model would
# buy an API bill from a checkbox with no way to avoid the double charge. Refused
# here rather than carried, because a silent drop is exactly the defect this seam
# is closing.
def test_an_ai_chunking_model_is_refused_rather_than_silently_applied() -> None:
    config = StubConfig()
    override = ConfigOverride(
        chunk_mode=ChunkModeOverride(chunk_size=480, chunking_model="kanon-2")
    )

    with pytest.raises(UnsupportedOverride) as refused:
        apply_config_override(config, override)

    assert "chunking_model" in str(refused.value)
    assert config.chunking.chunking_model is None


def test_the_plan_carries_the_override_to_every_stage_pass() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)
    override = ConfigOverride(chunk_mode=ChunkModeOverride(chunk_size=640))

    started = trigger.start(
        RunPlan(
            evaluation_id="eval-override",
            stage_sequence=DEFAULT_SEQUENCE,
            config_override=override,
        )
    )
    _wait_terminal(trigger, started["runId"])

    assert stages.calls == DEFAULT_SEQUENCE
    assert stages.overrides == [override] * len(DEFAULT_SEQUENCE)


def test_a_run_with_no_override_passes_none_below_the_seam() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    trigger = _build(queue, stages)

    started = trigger.start(
        RunPlan(evaluation_id="eval-default", stage_sequence=["chunk"])
    )
    _wait_terminal(trigger, started["runId"])

    assert stages.overrides == [None]


# --- The override on the wire ------------------------------------------------


def test_post_runs_carries_an_authored_override_below_the_seam() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    client = _client(queue, stages)

    response = client.post(
        "/runs",
        json={
            "evaluationId": "eval-wire",
            "stageSequence": ["chunk", "money"],
            "configOverride": {
                "chunkMode": {"chunkingModel": None, "chunkSize": 640, "chunkTables": False},
                "moneyVocabulary": {
                    "extraHeaderTerms": ["lump sum"],
                    "extraVetoTerms": [],
                    "defaultCurrency": "AUD",
                },
            },
        },
    )

    assert response.status_code == 202
    carried = stages.overrides[0]
    assert carried is not None
    assert carried.chunk_mode is not None
    assert carried.chunk_mode.chunk_size == 640
    assert carried.chunk_mode.chunk_tables is False
    assert carried.money_vocabulary is not None
    assert carried.money_vocabulary.extra_header_terms == ["lump sum"]
    assert carried.money_vocabulary.default_currency == "AUD"


def test_post_runs_without_an_override_still_fires_on_the_file_default() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    client = _client(queue, stages)

    response = client.post(
        "/runs", json={"evaluationId": "eval-plain", "stageSequence": ["chunk"]}
    )

    assert response.status_code == 202
    assert stages.overrides == [None]


# The exit test: a `POST /runs` carrying an OCR-engine override runs extraction
# against a config whose engine is the request's, not the file's. Both halves are
# asserted where they meet — the override reaches the worker (the only pass that
# reads `extraction.ocr.*`), and layering it over a file config yields the
# request's engine rather than the file's `paddleocr`.
def test_post_runs_runs_extraction_against_the_requested_ocr_engine() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    client = _client(queue, stages)

    response = client.post(
        "/runs",
        json={
            "evaluationId": "eval-ocr-wire",
            "stageSequence": ["chunk"],
            "configOverride": {"extraction": {"ocrEngine": "mistral-ocr", "ocrDpi": 400}},
        },
    )

    assert response.status_code == 202
    carried = queue.worker_overrides[0]
    assert carried is not None
    assert carried.extraction is not None
    assert carried.extraction.ocr_engine == "mistral-ocr"

    file_config = StubConfig()
    assert file_config.extraction.ocr.engine == "paddleocr"
    extracted_with = apply_config_override(file_config, carried)
    assert extracted_with.extraction.ocr.engine == "mistral-ocr"
    assert extracted_with.extraction.ocr.dpi == 400


def test_post_runs_refuses_an_ai_chunking_model_rather_than_dropping_it() -> None:
    queue = FakeQueue()
    stages = FakeStages()
    client = _client(queue, stages)

    response = client.post(
        "/runs",
        json={
            "evaluationId": "eval-ai",
            "stageSequence": ["chunk"],
            "configOverride": {
                "chunkMode": {"chunkingModel": "kanon-2", "chunkSize": 480, "chunkTables": True},
            },
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"
    assert "chunking_model" in response.json()["error"]["message"]
    assert stages.calls == []


# Pins the override against the *real* engine config rather than the stand-in
# above, wherever the engine is installed. Skips on the sidecar's plain [dev]
# environment, which does not carry the [womblex] extra.
def test_the_override_matches_the_real_engine_config_shape() -> None:
    womblex_config = pytest.importorskip("womblex.config")

    config = womblex_config.WomblexConfig.model_construct(
        chunking=womblex_config.ChunkingConfig(),
        money=womblex_config.MoneyConfig(),
        extraction=womblex_config.ExtractionConfig(),
    )
    override = ConfigOverride(
        chunk_mode=ChunkModeOverride(chunk_size=640, chunk_tables=False),
        money_vocabulary=MoneyVocabularyOverride(
            extra_header_terms=["schedule of rates"], default_currency="NZD"
        ),
        extraction=ExtractionOverride(ocr_engine="mistral-ocr", ocr_dpi=400),
    )

    applied = apply_config_override(config, override)

    assert applied.chunking.chunk_size == 640
    assert applied.chunking.chunk_tables is False
    assert applied.money.default_currency == "NZD"
    assert applied.money.columns.extra_header_terms == ["schedule of rates"]
    # `extraction.ocr.engine` / `.dpi` are the real keys `run_extraction` threads
    # into `extract_text` — verified against the pinned engine, not assumed.
    assert applied.extraction.ocr.engine == "mistral-ocr"
    assert applied.extraction.ocr.dpi == 400
