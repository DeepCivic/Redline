import type { Result } from "../result";

// redline's second seam to the womblex engine (architecture §3/§5). Object
// storage was the only coupling until now — the engine wrote shards, the sidecar
// read them back. This port adds the second: a trigger into the engine's job
// queue and a read of run state, so a browser reaches a run without a terminal
// driving enqueue / worker / run-stage by hand.
//
// It is a *thin* seam over the womblex-ingest sidecar's two JSON endpoints
// (`POST /runs`, `GET /runs/{runId}`, `POST /runs/{runId}/resume`). redline does
// not reimplement the engine's batching, retry or scale-out — those stay the
// engine's. redline drives and observes; it does not wrap.
//
// The ordering of the passes is the sidecar's, not the specialist's: the
// allow-listed stage *sequence* is authored here, but the dependency (chunk
// before embed) is enforced below the seam. So a request carries a sequence; what
// runs is that sequence normalised.

// The downstream passes the engine runs after extraction, in the caller-authored
// order. Only these four are authorable (architecture §2.1) — the structural
// stages (`link`, `pii`, …) are not run parameters and the sidecar refuses them.
export type AuthorableStage = "chunk" | "embed" | "enrich" | "money";

// What a run's status reduces to for a poller. `phase` is the coarse state a
// minutes-long run moves through; the surface above binds the four things it must
// show — started (extracting/staging), errored (which stage, why), resumable,
// done — to these fields.
export type RunPhase = "extracting" | "staging" | "done" | "errored";

export interface RunStatusView {
  readonly runId: string;
  readonly evaluationId: string;
  readonly phase: RunPhase;
  // The downstream stages that have completed, in run order. On a done run this
  // is the whole authored sequence; on an errored one it is the stages before
  // the failure.
  readonly completedStages: readonly string[];
  // The stage that failed, or null when the run has not errored. `womblex_jobs`
  // tracks extraction batches only, so the sidecar layers the current downstream
  // stage on top — this names which pass of the sequence went wrong.
  readonly failedStage: string | null;
  // Whether re-firing the trigger will make progress. Always true on an errored
  // run: the engine's enqueue is idempotent and completed stages skip on their
  // published outputs, so resume is safe. A failed stage is never a dead end.
  readonly resumable: boolean;
  // The failure reason, or null when the run has not errored — the engine's own
  // message for the failed batch, surfaced verbatim.
  readonly error: string | null;
}

export interface TriggerRunRequest {
  readonly evaluationId: string;
  // The allow-listed downstream stage sequence to run after extraction. The
  // caller authors it (a blank form field inherits the default at the surface
  // above, so a request always names at least one); the sidecar validates it
  // against the allow-list and normalises its ordering.
  readonly stageSequence: readonly AuthorableStage[];
}

export interface IWomblexRunTrigger {
  // Fire the fixed pass sequence for one evaluation: extraction, then the
  // authored downstream stages in dependency order. Returns the run id a poller
  // reads state by. A sidecar failure or an off-list stage returns a DomainError
  // rather than throwing across the seam.
  start(request: TriggerRunRequest): Promise<Result<{ readonly runId: string }>>;

  // Read a run's current state. NOT_FOUND for a run id the sidecar does not know.
  status(runId: string): Promise<Result<RunStatusView>>;

  // Re-fire a run by its id. Not a new run and not new logic: the engine's
  // idempotent enqueue and skip-on-output mean re-firing the same run picks up
  // where it stopped, so resume builds nothing of its own.
  resume(runId: string): Promise<Result<{ readonly runId: string }>>;
}
