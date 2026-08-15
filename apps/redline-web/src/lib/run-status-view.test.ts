import { describe, it, expect } from "vitest";
import type { RunStatusView } from "@redline/redline-domain";
import { renderRunStatusView } from "./run-status-view";

// The run-status view model is a pure RunStatusView → presentation transform the
// served route binds to. A womblex run is minutes-long and coarse, so the surface
// polls the status seam and renders whichever of the four states it is in —
// started, errored (which stage, why), resumable, done. The Playwright e2e proves
// the DOM; this proves the model the DOM binds to, with no browser and no seam.

const view = (over: Partial<RunStatusView> = {}): RunStatusView => ({
  runId: "run-1",
  evaluationId: "tender-2026-water",
  phase: "staging",
  completedStages: ["chunk", "embed"],
  failedStage: null,
  resumable: false,
  error: null,
  ...over,
});

describe("renderRunStatusView", () => {
  it("shows a running pass as in-progress, not settled, and not resumable", () => {
    const model = renderRunStatusView(view({ phase: "extracting", completedStages: [] }));

    expect(model.isRunning).toBe(true);
    expect(model.isSettled).toBe(false);
    expect(model.canResume).toBe(false);
    expect(model.statusLabel).toBe("Extracting documents");
  });

  it("labels the staging phase after extraction distinctly from extracting", () => {
    const extracting = renderRunStatusView(view({ phase: "extracting" }));
    const staging = renderRunStatusView(view({ phase: "staging" }));

    expect(extracting.statusLabel).not.toBe(staging.statusLabel);
    expect(staging.statusLabel).toBe("Running stages");
  });

  it("marks a done run settled, complete, and lists every stage it ran", () => {
    const model = renderRunStatusView(
      view({
        phase: "done",
        completedStages: ["chunk", "embed", "enrich", "money"],
        resumable: false,
      }),
    );

    expect(model.isRunning).toBe(false);
    expect(model.isSettled).toBe(true);
    expect(model.isComplete).toBe(true);
    expect(model.isErrored).toBe(false);
    expect(model.canResume).toBe(false);
    expect(model.completedStages).toEqual(["chunk", "embed", "enrich", "money"]);
    expect(model.statusLabel).toBe("Run complete");
  });

  it("names the failed stage, surfaces why, and offers resume — never an endless spinner", () => {
    const model = renderRunStatusView(
      view({
        phase: "errored",
        completedStages: ["chunk"],
        failedStage: "embed",
        resumable: true,
        error: "embed pass exhausted retries",
      }),
    );

    expect(model.isRunning).toBe(false);
    expect(model.isSettled).toBe(true);
    expect(model.isErrored).toBe(true);
    expect(model.isComplete).toBe(false);
    expect(model.failedStage).toBe("embed");
    expect(model.errorMessage).toBe("embed pass exhausted retries");
    expect(model.canResume).toBe(true);
    expect(model.statusLabel).toBe("Embed stage failed");
  });

  it("labels the graph-refresh stage, which the sidecar inserts rather than the form authoring", () => {
    // AI chunking runs enrich before chunk, so the sidecar appends graph-refresh
    // to rebuild the mention->chunk edges. It reaches this view like any other
    // stage, and without a label it would render as the raw slug beside "Chunk".
    const model = renderRunStatusView(
      view({
        phase: "errored",
        completedStages: ["enrich", "chunk"],
        failedStage: "graph-refresh",
        resumable: true,
        error: "graph-refresh pass failed",
      }),
    );

    expect(model.statusLabel).toBe("Graph refresh stage failed");
  });

  it("keeps polling only while the run is unsettled", () => {
    expect(renderRunStatusView(view({ phase: "extracting" })).shouldKeepPolling).toBe(true);
    expect(renderRunStatusView(view({ phase: "staging" })).shouldKeepPolling).toBe(true);
    expect(renderRunStatusView(view({ phase: "done" })).shouldKeepPolling).toBe(false);
    expect(renderRunStatusView(view({ phase: "errored", resumable: true })).shouldKeepPolling).toBe(
      false,
    );
  });

  it("carries the run and evaluation ids through so the route can poll and resume", () => {
    const model = renderRunStatusView(view({ runId: "run-9", evaluationId: "eval-x" }));

    expect(model.runId).toBe("run-9");
    expect(model.evaluationId).toBe("eval-x");
  });
});
