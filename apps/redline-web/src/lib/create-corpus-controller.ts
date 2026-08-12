import {
  isErr,
  ok,
  makeRunConfigOverride,
  type AuthorableStage,
  type Evaluation,
  type IStagedCorpusWriter,
  type IWomblexRunTrigger,
  type Result,
  type RunConfigOverride,
  type RunConfigOverrideInput,
  type StagedUpload,
} from "@redline/redline-domain";
import type { CreateEvaluationInput } from "@redline/redline-application";

// CreateCorpusController — the Create Corpus surface's write brain (delivery-plan
// §2 item 1; matching WorkflowController / RunStatusController — wiring stays in
// container.ts, the controller drives its seams and returns Results). It owns the
// two write seams the served container gained: the object-store writer
// (IStagedCorpusWriter, putting a specialist's chosen bytes under the
// evaluation's input prefix) and the run trigger (IWomblexRunTrigger, firing the
// pass sequence against the authored config).
//
// `createCorpus` is the seed script's middle, minus the manifest: stage every
// chosen document, create the evaluation, then trigger the run that ingest → lens
// → grouping → build hangs off. The three steps are also exposed individually so
// a surface that stages incrementally (an upload at a time) can drive them one by
// one. Every seam error returns as a Result — nothing throws across the boundary,
// and a step never runs on a failed prior step (a failed stage never creates an
// evaluation the operator cannot retry over, per CreateEvaluation's own posture).

// The create use-case as a shape rather than the concrete class, so the
// controller is testable with a fake and the container injects the real
// CreateEvaluation. The application layer owns the blank-name / unknown-document
// / already-claimed rules; this controller does not re-check them.
export interface CreateEvaluationUseCase {
  execute(input: CreateEvaluationInput): Promise<Result<Evaluation>>;
}

export interface CreateCorpusControllerParts {
  readonly writer: IStagedCorpusWriter;
  readonly runTrigger: IWomblexRunTrigger;
  readonly createEvaluation: CreateEvaluationUseCase;
}

export interface StageDocumentInput {
  readonly evaluationId: string;
  readonly upload: StagedUpload;
}

// The run to fire, as the surface authors it: the evaluation, the stage
// sequence, and the *raw* config override the form composed. The override is a
// RunConfigOverrideInput (unvalidated) rather than a RunConfigOverride, because
// validating it is this controller's job — it re-checks through the domain's
// makeRunConfigOverride before firing, so the UI can never hand the sidecar a
// shape the allow-list would reject (the WorkflowManager.toAssignmentInput
// posture).
export interface StartRunInput {
  readonly evaluationId: string;
  readonly stageSequence: readonly AuthorableStage[];
  readonly configOverride?: RunConfigOverrideInput;
}

export interface CreateCorpusInput {
  readonly evaluation: CreateEvaluationInput;
  readonly uploads: readonly StagedUpload[];
  readonly stageSequence: readonly AuthorableStage[];
  readonly configOverride?: RunConfigOverrideInput;
}

export interface CreateCorpusResult {
  readonly evaluationId: string;
  readonly runId: string;
}

// A validated override with both groups null is the same as no override at all
// — the form left everything blank and the run inherits the file default. Return
// undefined for that case so the trigger request omits configOverride entirely,
// rather than sending an empty shape the sidecar would merge to a no-op.
const attachedOverride = (
  override: RunConfigOverride,
): RunConfigOverride | undefined =>
  override.chunkMode === null && override.moneyVocabulary === null ? undefined : override;

export class CreateCorpusController {
  private readonly writer: IStagedCorpusWriter;
  private readonly runTrigger: IWomblexRunTrigger;
  private readonly createEvaluationUseCase: CreateEvaluationUseCase;

  constructor(parts: CreateCorpusControllerParts) {
    this.writer = parts.writer;
    this.runTrigger = parts.runTrigger;
    this.createEvaluationUseCase = parts.createEvaluation;
  }

  // Put one document's bytes under the evaluation's input prefix. The key it
  // landed at is the caller's receipt; the bytes are an input to a run that has
  // not happened.
  stageDocument(input: StageDocumentInput): Promise<Result<{ readonly key: string }>> {
    return this.writer.stage(input.evaluationId, input.upload);
  }

  // Compose and persist the evaluation over the chosen corpus. Pure pass-through
  // to the use-case, which owns every rule.
  createEvaluation(input: CreateEvaluationInput): Promise<Result<Evaluation>> {
    return this.createEvaluationUseCase.execute(input);
  }

  // Fire the authored pass sequence (and any config override) for the
  // evaluation; returns the run id the surface then polls by through
  // RunStatusController. The override is validated through the domain's
  // makeRunConfigOverride first — a malformed one (a non-positive chunk size, a
  // non-ISO currency, a blank term) is refused here, before the sidecar sees it.
  // The sidecar still owns stage ordering and allow-list validation below the
  // seam.
  async startRun(input: StartRunInput): Promise<Result<{ readonly runId: string }>> {
    const override = makeRunConfigOverride(input.configOverride ?? {});
    if (isErr(override)) return override;

    return this.runTrigger.start({
      evaluationId: input.evaluationId,
      stageSequence: input.stageSequence,
      configOverride: attachedOverride(override.data),
    });
  }

  // The whole create sequence: validate the override, stage every document,
  // create the evaluation, then trigger the run. The override is checked first,
  // so a malformed one stops before anything is staged — nothing half-composed is
  // left behind for a run that could never fire. A failed stage then stops before
  // create, and a failed create stops before trigger — the ordering
  // CreateEvaluation's upsert posture requires, so a half-composed corpus never
  // leaves a run firing over bytes an evaluation cannot read.
  async createCorpus(input: CreateCorpusInput): Promise<Result<CreateCorpusResult>> {
    const evaluationId = input.evaluation.corpusId;

    const override = makeRunConfigOverride(input.configOverride ?? {});
    if (isErr(override)) return override;

    for (const upload of input.uploads) {
      const staged = await this.writer.stage(evaluationId, upload);
      if (isErr(staged)) return staged;
    }

    const created = await this.createEvaluationUseCase.execute(input.evaluation);
    if (isErr(created)) return created;

    const started = await this.runTrigger.start({
      evaluationId,
      stageSequence: input.stageSequence,
      configOverride: attachedOverride(override.data),
    });
    if (isErr(started)) return started;

    return ok({ evaluationId, runId: started.data.runId });
  }
}
