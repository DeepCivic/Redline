import { describe, it, expect } from "vitest";
import { isOk, isErr, err, ok, type Result } from "../result";
import { domainError } from "../errors/domain-error";
import type {
  IWomblexRunTrigger,
  RunStatusView,
  TriggerRunRequest,
} from "./womblex-run-trigger";

// The run-trigger port's spec — redline's second seam to the womblex engine.
// Until now object storage was the only coupling: the engine wrote shards, the
// sidecar read them back. This port adds the second seam (architecture §3/§5): a
// trigger into the engine's job queue and a read of run state, so a browser
// "start run" reaches the engine without a terminal driving enqueue / worker /
// run-stage by hand.
//
// The port is deliberately thin — two calls. `start` fires the fixed pass
// sequence for one evaluation against the UI-authored config; `status` reads
// where the run is. Resume is not a third capability: re-firing the same trigger
// is resume, because the engine's enqueue is idempotent and completed stages skip
// on their published outputs, so `start` carries the run id it may reuse.
//
// The ordering of the passes is the sidecar's, not the specialist's: the
// allow-listed *sequence* is authored, but the dependency (chunk before embed) is
// enforced below the seam. So a request carries a sequence; what runs is that
// sequence normalised.

// A dependency-free in-memory trigger. It records the request it received and
// hands back a status view a poller reads, so the port's four surfaced states —
// started, errored (which stage, why), resumable, done — are asserted against a
// concrete double before any HTTP adapter exists.
class InMemoryRunTrigger implements IWomblexRunTrigger {
  readonly requests: TriggerRunRequest[] = [];
  private readonly views = new Map<string, RunStatusView>();
  nextRunId = "run-1";
  failStage: string | null = null;

  async start(request: TriggerRunRequest): Promise<Result<{ readonly runId: string }>> {
    if (request.evaluationId.length === 0) {
      return err(domainError("VALIDATION_FAILED", "evaluationId must be non-empty"));
    }
    if (request.stageSequence.length === 0) {
      return err(domainError("VALIDATION_FAILED", "stageSequence must name at least one stage"));
    }
    this.requests.push(request);
    const runId = this.nextRunId;
    this.views.set(runId, this.viewFor(runId, request));
    return ok({ runId });
  }

  async status(runId: string): Promise<Result<RunStatusView>> {
    const view = this.views.get(runId);
    if (view === undefined) {
      return err(domainError("NOT_FOUND", `no run with id ${runId}`));
    }
    return ok(view);
  }

  async resume(runId: string): Promise<Result<{ readonly runId: string }>> {
    if (!this.views.has(runId)) {
      return err(domainError("NOT_FOUND", `no run with id ${runId}`));
    }
    return ok({ runId });
  }

  private viewFor(runId: string, request: TriggerRunRequest): RunStatusView {
    if (this.failStage !== null) {
      const before = request.stageSequence.slice(
        0,
        request.stageSequence.indexOf(this.failStage),
      );
      return {
        runId,
        evaluationId: request.evaluationId,
        phase: "errored",
        completedStages: before,
        failedStage: this.failStage,
        resumable: true,
        error: `${this.failStage} pass exhausted retries`,
      };
    }
    return {
      runId,
      evaluationId: request.evaluationId,
      phase: "done",
      completedStages: request.stageSequence,
      failedStage: null,
      resumable: false,
      error: null,
    };
  }
}

const request = (over: Partial<TriggerRunRequest> = {}): TriggerRunRequest => ({
  evaluationId: "tender-2026-water",
  stageSequence: ["chunk", "embed", "enrich", "money"],
  ...over,
});

describe("IWomblexRunTrigger — triggering and observing a womblex run", () => {
  it("starts a run for an evaluation and returns the run id a poller tracks", async () => {
    const trigger = new InMemoryRunTrigger();

    const started = await trigger.start(request());

    expect(isOk(started)).toBe(true);
    if (!isOk(started)) return;
    expect(started.data.runId).toBe("run-1");
    expect(trigger.requests[0]?.evaluationId).toBe("tender-2026-water");
  });

  it("carries the authored stage sequence through to the engine unaltered by the port", async () => {
    const trigger = new InMemoryRunTrigger();

    await trigger.start(request({ stageSequence: ["chunk", "embed"] }));

    expect(trigger.requests[0]?.stageSequence).toEqual(["chunk", "embed"]);
  });

  it("reports a done run naming every stage it completed", async () => {
    const trigger = new InMemoryRunTrigger();
    const started = await trigger.start(request());
    if (!isOk(started)) return;

    const view = await trigger.status(started.data.runId);

    expect(isOk(view)).toBe(true);
    if (!isOk(view)) return;
    expect(view.data.phase).toBe("done");
    expect(view.data.completedStages).toEqual(["chunk", "embed", "enrich", "money"]);
    expect(view.data.error).toBeNull();
  });

  it("names the stage that failed, says why, and marks the run resumable", async () => {
    const trigger = new InMemoryRunTrigger();
    trigger.failStage = "embed";
    const started = await trigger.start(request());
    if (!isOk(started)) return;

    const view = await trigger.status(started.data.runId);

    expect(isOk(view)).toBe(true);
    if (!isOk(view)) return;
    expect(view.data.phase).toBe("errored");
    expect(view.data.failedStage).toBe("embed");
    expect(view.data.error).toContain("embed");
    // A failed stage never presents as a spinner that never resolves.
    expect(view.data.resumable).toBe(true);
    // The stage before the failure completed; the ones after never ran.
    expect(view.data.completedStages).toEqual(["chunk"]);
  });

  it("resumes a run by its id — re-firing the same trigger, not a new run", async () => {
    const trigger = new InMemoryRunTrigger();
    const started = await trigger.start(request());
    if (!isOk(started)) return;

    const resumed = await trigger.resume(started.data.runId);

    expect(isOk(resumed)).toBe(true);
    if (!isOk(resumed)) return;
    expect(resumed.data.runId).toBe(started.data.runId);
  });

  it("reports NOT_FOUND for the status of an unknown run", async () => {
    const view = await new InMemoryRunTrigger().status("no-such-run");

    expect(isErr(view)).toBe(true);
    if (!isErr(view)) return;
    expect(view.error.code).toBe("NOT_FOUND");
  });

  it("refuses to start a run with no evaluation id", async () => {
    const started = await new InMemoryRunTrigger().start(request({ evaluationId: "" }));

    expect(isErr(started)).toBe(true);
    if (!isErr(started)) return;
    expect(started.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses to start a run with an empty stage sequence", async () => {
    const started = await new InMemoryRunTrigger().start(request({ stageSequence: [] }));

    expect(isErr(started)).toBe(true);
    if (!isErr(started)) return;
    expect(started.error.code).toBe("VALIDATION_FAILED");
  });
});
