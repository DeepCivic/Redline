import type { RunPhase, RunStatusView } from "@redline/redline-domain";

// View model for the Create Corpus run tracker. A pure RunStatusView →
// presentation transform the served route binds to (matching view.ts /
// review-view.ts — the DOM stays dumb, the state logic stays tested). A womblex
// run is minutes-long and moves state coarsely, so the route polls the status
// seam and renders whichever of the four states this reduces to: started
// (running), errored (which stage, why), resumable, done. The rule the surface
// must honour — a failed stage names itself and offers resume, it is never a
// spinner that never resolves — lives here as `isErrored`/`failedStage`/`canResume`
// and `shouldKeepPolling`, not in the shell.

const STAGE_LABELS: Record<string, string> = {
  chunk: "Chunk",
  embed: "Embed",
  enrich: "Enrich",
  money: "Money",
};

const PHASE_LABELS: Record<RunPhase, string> = {
  extracting: "Extracting documents",
  staging: "Running stages",
  done: "Run complete",
  errored: "Run failed",
};

export interface RunStatusViewModel {
  readonly runId: string;
  readonly evaluationId: string;
  // A short label the surface shows as the run's headline state. On an errored
  // run it names the failed stage rather than a generic failure.
  readonly statusLabel: string;
  // The run is mid-flight: extracting or running downstream stages.
  readonly isRunning: boolean;
  // The run has reached a terminal state — done or errored. A settled run is one
  // the poller can stop on; an unsettled one it keeps polling.
  readonly isSettled: boolean;
  readonly isComplete: boolean;
  readonly isErrored: boolean;
  // The downstream stages that finished, in run order. The whole authored
  // sequence on a done run; the stages before the failure on an errored one.
  readonly completedStages: readonly string[];
  // The stage that failed, or null when the run has not errored.
  readonly failedStage: string | null;
  // The engine's own message for the failed batch, or null when not errored.
  readonly errorMessage: string | null;
  // Whether re-firing the trigger will make progress. True on an errored run
  // because the engine's enqueue is idempotent and completed stages skip — so a
  // failed stage always offers resume.
  readonly canResume: boolean;
  // Whether the route should schedule another poll. Only while unsettled.
  readonly shouldKeepPolling: boolean;
}

const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage;

const statusLabelFor = (status: RunStatusView): string => {
  if (status.phase !== "errored") return PHASE_LABELS[status.phase];
  if (status.failedStage === null) return "Run failed";
  return `${stageLabel(status.failedStage)} stage failed`;
};

export const renderRunStatusView = (status: RunStatusView): RunStatusViewModel => {
  const isErrored = status.phase === "errored";
  const isComplete = status.phase === "done";
  const isSettled = isErrored || isComplete;

  return {
    runId: status.runId,
    evaluationId: status.evaluationId,
    statusLabel: statusLabelFor(status),
    isRunning: !isSettled,
    isSettled,
    isComplete,
    isErrored,
    completedStages: status.completedStages,
    failedStage: status.failedStage,
    errorMessage: status.error,
    canResume: isErrored && status.resumable,
    shouldKeepPolling: !isSettled,
  };
};
