import {
  isErr,
  ok,
  type IWomblexRunTrigger,
  type Result,
  type TriggerRunRequest,
} from "@redline/redline-domain";
import { renderRunStatusView, type RunStatusViewModel } from "./run-status-view";

// RunStatusController — the served Create Corpus route's brain for triggering and
// tracking a womblex run (matching WorkflowController — wiring stays in
// container.ts, the controller drives a seam and shapes its result). It owns the
// status seam: start a run, poll it into the view model the route binds to,
// resume a failed one. It builds no resume logic of its own — the port's contract
// is that re-firing the same trigger is resume, because the engine's enqueue is
// idempotent and completed stages skip on their published outputs.

export interface RunStatusControllerParts {
  readonly runTrigger: IWomblexRunTrigger;
}

export class RunStatusController {
  private readonly runTrigger: IWomblexRunTrigger;

  constructor(parts: RunStatusControllerParts) {
    this.runTrigger = parts.runTrigger;
  }

  // Fire the fixed pass sequence for one evaluation; returns the run id the route
  // then polls by. The sidecar owns ordering and allow-list validation below the
  // seam, so this is a pass-through, not an orchestrator.
  start(request: TriggerRunRequest): Promise<Result<{ readonly runId: string }>> {
    return this.runTrigger.start(request);
  }

  // Read a run's current state and shape it into the presentation model. A seam
  // error (a run the sidecar does not know, an unreachable sidecar) is returned,
  // never thrown across the boundary — the route renders it rather than crashing
  // the poll.
  async poll(input: { runId: string }): Promise<Result<RunStatusViewModel>> {
    const status = await this.runTrigger.status(input.runId);
    if (isErr(status)) return status;
    return ok(renderRunStatusView(status.data));
  }

  // Re-fire a failed run. Not a new run: the trigger's idempotent enqueue picks
  // up where the run stopped, so this offers no logic beyond the seam call.
  resume(input: { runId: string }): Promise<Result<{ readonly runId: string }>> {
    return this.runTrigger.resume(input.runId);
  }
}
