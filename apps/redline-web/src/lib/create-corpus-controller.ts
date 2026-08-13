import {
  isErr,
  ok,
  err,
  domainError,
  makeRunConfigOverride,
  type AuthorableStage,
  type IStagedCorpusWriter,
  type IWomblexRunTrigger,
  type Result,
  type RunConfigOverride,
  type RunConfigOverrideInput,
  type StagedUpload,
} from "@redline/redline-domain";

// CreateCorpusController — the Create Corpus surface's write brain (matching
// WorkflowController / RunStatusController — wiring stays in container.ts, the
// controller drives its seams and returns Results). It owns the two write seams
// the served container gained: the object-store writer (IStagedCorpusWriter,
// putting a specialist's chosen bytes under the run's input prefix) and the run
// trigger (IWomblexRunTrigger, firing the pass sequence against the authored
// config).
//
// `createCorpus` is the cold-start sequence: stage every chosen document under
// the run's own name, then fire the run. The two steps are also exposed
// individually so a surface that stages incrementally (an upload at a time) can
// drive them one by one. Every seam error returns as a Result — nothing throws
// across the boundary, and the run never fires on a failed stage, because a run
// over a half-staged prefix extracts part of the corpus and reports success.
//
// There is deliberately no create-evaluation seam here. womblex is a cold-start
// engine: it mints each document's source_hash when it extracts, so brands and
// fields cannot be named against documents until the run has drained.
// /evaluations/new composes the evaluation over the finished corpus.

export interface CreateCorpusControllerParts {
  readonly writer: IStagedCorpusWriter;
  readonly runTrigger: IWomblexRunTrigger;
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

// The run as the ingest surface authors it. `runName` is what the specialist
// typed: it is the womblex run, the object-store prefix and the corpus id the
// evaluation is later composed over — one identity, minted by nobody here.
export interface CreateCorpusInput {
  readonly runName: string;
  readonly uploads: readonly StagedUpload[];
  readonly stageSequence: readonly AuthorableStage[];
  readonly configOverride?: RunConfigOverrideInput;
}

export interface CreateCorpusResult {
  readonly corpusId: string;
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

  constructor(parts: CreateCorpusControllerParts) {
    this.writer = parts.writer;
    this.runTrigger = parts.runTrigger;
  }

  // Put one document's bytes under the evaluation's input prefix. The key it
  // landed at is the caller's receipt; the bytes are an input to a run that has
  // not happened.
  stageDocument(input: StageDocumentInput): Promise<Result<{ readonly key: string }>> {
    return this.writer.stage(input.evaluationId, input.upload);
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

  // The whole ingest sequence: check the run is nameable and has documents,
  // validate the override, stage every document under the run's prefix, then fire
  // the run. The checks come first, so a malformed request stages nothing — a
  // half-staged prefix is worse than an unstarted run, because the engine would
  // extract part of the corpus and report success over it.
  async createCorpus(input: CreateCorpusInput): Promise<Result<CreateCorpusResult>> {
    const corpusId = input.runName.trim();
    if (corpusId === "") {
      return err(domainError("VALIDATION_FAILED", "a run needs a name"));
    }
    if (input.uploads.length === 0) {
      return err(
        domainError("VALIDATION_FAILED", "a run needs at least one document to extract"),
      );
    }

    const override = makeRunConfigOverride(input.configOverride ?? {});
    if (isErr(override)) return override;

    for (const upload of input.uploads) {
      const staged = await this.writer.stage(corpusId, upload);
      if (isErr(staged)) return staged;
    }

    const started = await this.runTrigger.start({
      evaluationId: corpusId,
      stageSequence: input.stageSequence,
      configOverride: attachedOverride(override.data),
    });
    if (isErr(started)) return started;

    return ok({ corpusId, runId: started.data.runId });
  }
}
