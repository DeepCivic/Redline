import { describe, it, expect } from "vitest";
import {
  domainError,
  err,
  isErr,
  isOk,
  ok,
  type IWomblexRunTrigger,
  type Result,
  type RunStatusView,
  type TriggerRunRequest,
} from "@redline/redline-domain";
import { RunStatusController } from "./run-status-controller";

// The run-status controller is the served route's brain for the Create Corpus
// run: it drives the status seam (IWomblexRunTrigger) — start a run, poll it into
// the view model the route binds to, resume a failed one — and never lets a seam
// error throw across the boundary. It builds nothing of its own: resume is
// re-firing the same trigger, exactly as the port's contract says.

// A dependency-free double of the run seam, so the controller is proven without
// the HTTP sidecar. It records the requests it saw and hands back a view a poll
// reads, matching the domain port's own InMemoryRunTrigger.
class FakeRunTrigger implements IWomblexRunTrigger {
  readonly started: TriggerRunRequest[] = [];
  readonly resumed: string[] = [];
  nextRunId = "run-1";
  statusView: RunStatusView | null = null;
  statusError: string | null = null;

  async start(request: TriggerRunRequest): Promise<Result<{ readonly runId: string }>> {
    this.started.push(request);
    return ok({ runId: this.nextRunId });
  }

  async status(runId: string): Promise<Result<RunStatusView>> {
    if (this.statusError !== null) {
      return err(domainError("NOT_FOUND", this.statusError));
    }
    if (this.statusView === null) {
      return err(domainError("NOT_FOUND", `no run with id ${runId}`));
    }
    return ok(this.statusView);
  }

  async resume(runId: string): Promise<Result<{ readonly runId: string }>> {
    this.resumed.push(runId);
    return ok({ runId });
  }
}

const doneView = (over: Partial<RunStatusView> = {}): RunStatusView => ({
  runId: "run-1",
  evaluationId: "tender-2026-water",
  phase: "done",
  completedStages: ["chunk", "embed", "enrich", "money"],
  failedStage: null,
  resumable: false,
  error: null,
  ...over,
});

describe("RunStatusController", () => {
  it("starts a run for an evaluation and returns the run id the route polls by", async () => {
    const trigger = new FakeRunTrigger();
    trigger.nextRunId = "run-42";
    const controller = new RunStatusController({ runTrigger: trigger });

    const started = await controller.start({
      evaluationId: "tender-2026-water",
      stageSequence: ["chunk", "embed"],
    });

    expect(isOk(started)).toBe(true);
    if (!isOk(started)) return;
    expect(started.data.runId).toBe("run-42");
    expect(trigger.started[0]?.stageSequence).toEqual(["chunk", "embed"]);
  });

  it("polls a run into the view model the route binds to", async () => {
    const trigger = new FakeRunTrigger();
    trigger.statusView = doneView();
    const controller = new RunStatusController({ runTrigger: trigger });

    const polled = await controller.poll({ runId: "run-1" });

    expect(isOk(polled)).toBe(true);
    if (!isOk(polled)) return;
    expect(polled.data.isComplete).toBe(true);
    expect(polled.data.shouldKeepPolling).toBe(false);
    expect(polled.data.statusLabel).toBe("Run complete");
  });

  it("surfaces a failed run's stage and resume offer through the view model", async () => {
    const trigger = new FakeRunTrigger();
    trigger.statusView = doneView({
      phase: "errored",
      completedStages: ["chunk"],
      failedStage: "embed",
      resumable: true,
      error: "embed pass exhausted retries",
    });
    const controller = new RunStatusController({ runTrigger: trigger });

    const polled = await controller.poll({ runId: "run-1" });

    expect(isOk(polled)).toBe(true);
    if (!isOk(polled)) return;
    expect(polled.data.isErrored).toBe(true);
    expect(polled.data.failedStage).toBe("embed");
    expect(polled.data.canResume).toBe(true);
    expect(polled.data.shouldKeepPolling).toBe(false);
  });

  it("returns the seam error rather than throwing when a poll cannot resolve", async () => {
    const trigger = new FakeRunTrigger();
    trigger.statusError = "sidecar unreachable";
    const controller = new RunStatusController({ runTrigger: trigger });

    const polled = await controller.poll({ runId: "run-1" });

    expect(isErr(polled)).toBe(true);
    if (!isErr(polled)) return;
    expect(polled.error.code).toBe("NOT_FOUND");
  });

  it("resumes a run by re-firing the same trigger — not a new run", async () => {
    const trigger = new FakeRunTrigger();
    const controller = new RunStatusController({ runTrigger: trigger });

    const resumed = await controller.resume({ runId: "run-7" });

    expect(isOk(resumed)).toBe(true);
    if (!isOk(resumed)) return;
    expect(resumed.data.runId).toBe("run-7");
    expect(trigger.resumed).toEqual(["run-7"]);
    expect(trigger.started).toEqual([]);
  });
});
