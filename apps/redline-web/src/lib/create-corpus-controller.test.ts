import { describe, it, expect } from "vitest";
import {
  isErr,
  isOk,
  ok,
  err,
  domainError,
  type Evaluation,
  type IStagedCorpusWriter,
  type IWomblexRunTrigger,
  type Result,
  type RunStatusView,
  type StagedUpload,
  type TriggerRunRequest,
} from "@redline/redline-domain";
import type { CreateEvaluationInput } from "@redline/redline-application";
import { CreateCorpusController } from "./create-corpus-controller";

// The Create Corpus controller is the surface's write brain (delivery-plan §2
// item 1): it owns the two seams the served container gained — the object-store
// writer (IStagedCorpusWriter, staging a specialist's bytes under the evaluation's
// input prefix) and the run trigger (IWomblexRunTrigger, firing the pass sequence
// against the authored config). It drives the seed script's middle, minus the
// manifest: stage the chosen bytes, create the evaluation, then trigger the run
// that ingest → lens → grouping → build hangs off. Every seam error returns as a
// Result — nothing throws across the boundary.

class FakeStagedCorpusWriter implements IStagedCorpusWriter {
  readonly staged: { evaluationId: string; upload: StagedUpload }[] = [];
  rejectFileName: string | null = null;

  async stage(
    evaluationId: string,
    upload: StagedUpload,
  ): Promise<Result<{ readonly key: string }>> {
    if (this.rejectFileName !== null && upload.fileName === this.rejectFileName) {
      return err(domainError("INFRA_FAILURE", `bucket rejected ${upload.fileName}`));
    }
    this.staged.push({ evaluationId, upload });
    return ok({ key: `proc/${evaluationId}/inputs/${upload.fileName}` });
  }
}

class FakeRunTrigger implements IWomblexRunTrigger {
  readonly started: TriggerRunRequest[] = [];
  nextRunId = "run-1";
  startError: string | null = null;

  async start(request: TriggerRunRequest): Promise<Result<{ readonly runId: string }>> {
    if (this.startError !== null) {
      return err(domainError("INFRA_FAILURE", this.startError));
    }
    this.started.push(request);
    return ok({ runId: this.nextRunId });
  }
  async status(): Promise<Result<RunStatusView>> {
    return err(domainError("NOT_FOUND", "unused"));
  }
  async resume(runId: string): Promise<Result<{ readonly runId: string }>> {
    return ok({ runId });
  }
}

class FakeCreateEvaluation {
  readonly inputs: CreateEvaluationInput[] = [];
  error: string | null = null;

  async execute(input: CreateEvaluationInput): Promise<Result<Evaluation>> {
    if (this.error !== null) {
      return err(domainError("VALIDATION_FAILED", this.error));
    }
    this.inputs.push(input);
    return ok({ id: input.corpusId, name: input.name, stage: "documents_uploaded" });
  }
}

const upload = (over: Partial<StagedUpload> = {}): StagedUpload => ({
  fileName: "acme-response.pdf",
  bytes: new Uint8Array([1, 2, 3]),
  contentType: "application/pdf",
  ...over,
});

const createInput = (
  over: Partial<CreateEvaluationInput> = {},
): CreateEvaluationInput => ({
  corpusId: "tender-2026-water",
  name: "Water treatment panel 2026",
  documents: [{ documentId: "doc-1", brand: "Acme" }],
  fields: [{ name: "Warranty", definition: "The warranty offered." }],
  ...over,
});

const build = () => {
  const writer = new FakeStagedCorpusWriter();
  const runTrigger = new FakeRunTrigger();
  const createEvaluation = new FakeCreateEvaluation();
  const controller = new CreateCorpusController({ writer, runTrigger, createEvaluation });
  return { writer, runTrigger, createEvaluation, controller };
};

describe("CreateCorpusController — staging chosen bytes", () => {
  it("stages a document under the evaluation's input prefix and returns its key", async () => {
    const { controller, writer } = build();

    const staged = await controller.stageDocument({
      evaluationId: "tender-2026-water",
      upload: upload(),
    });

    expect(isOk(staged)).toBe(true);
    if (!isOk(staged)) return;
    expect(staged.data.key).toBe("proc/tender-2026-water/inputs/acme-response.pdf");
    expect(writer.staged[0]?.evaluationId).toBe("tender-2026-water");
  });

  it("surfaces a bucket failure as a Result rather than throwing", async () => {
    const { controller, writer } = build();
    writer.rejectFileName = "acme-response.pdf";

    const staged = await controller.stageDocument({
      evaluationId: "tender-2026-water",
      upload: upload(),
    });

    expect(isErr(staged)).toBe(true);
    if (!isErr(staged)) return;
    expect(staged.error.code).toBe("INFRA_FAILURE");
  });
});

describe("CreateCorpusController — creating the evaluation", () => {
  it("creates the evaluation under the corpus's own id", async () => {
    const { controller, createEvaluation } = build();

    const created = await controller.createEvaluation(createInput());

    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.data.id).toBe("tender-2026-water");
    expect(createEvaluation.inputs[0]?.name).toBe("Water treatment panel 2026");
  });

  it("surfaces a create-use-case failure rather than throwing", async () => {
    const { controller, createEvaluation } = build();
    createEvaluation.error = "an evaluation needs at least one document";

    const created = await controller.createEvaluation(createInput({ documents: [] }));

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("CreateCorpusController — triggering the run", () => {
  it("fires the authored stage sequence for the evaluation and returns the run id", async () => {
    const { controller, runTrigger } = build();
    runTrigger.nextRunId = "run-42";

    const started = await controller.startRun({
      evaluationId: "tender-2026-water",
      stageSequence: ["chunk", "embed"],
    });

    expect(isOk(started)).toBe(true);
    if (!isOk(started)) return;
    expect(started.data.runId).toBe("run-42");
    expect(runTrigger.started[0]?.stageSequence).toEqual(["chunk", "embed"]);
  });

  it("carries the allow-listed config override through to the run", async () => {
    const { controller, runTrigger } = build();

    const started = await controller.startRun({
      evaluationId: "tender-2026-water",
      stageSequence: ["chunk", "embed", "enrich", "money"],
      configOverride: {
        chunkMode: { chunkingModel: null, chunkSize: 320, chunkTables: false },
        moneyVocabulary: {
          extraHeaderTerms: ["subtotal"],
          extraVetoTerms: [],
          defaultCurrency: "AUD",
        },
      },
    });

    expect(isOk(started)).toBe(true);
    expect(runTrigger.started[0]?.configOverride?.chunkMode?.chunkSize).toBe(320);
    expect(runTrigger.started[0]?.configOverride?.moneyVocabulary?.defaultCurrency).toBe("AUD");
  });

  it("normalises the override through the domain before firing (money terms trimmed and cased)", async () => {
    const { controller, runTrigger } = build();

    await controller.startRun({
      evaluationId: "tender-2026-water",
      stageSequence: ["money"],
      configOverride: {
        moneyVocabulary: {
          extraHeaderTerms: [" Subtotal ", "subtotal"],
          extraVetoTerms: [],
          defaultCurrency: "aud",
        },
      },
    });

    // De-duplicated, trimmed, lower-cased terms; upper-cased ISO currency — the
    // sidecar never sees the form's raw text.
    expect(runTrigger.started[0]?.configOverride?.moneyVocabulary?.extraHeaderTerms).toEqual([
      "subtotal",
    ]);
    expect(runTrigger.started[0]?.configOverride?.moneyVocabulary?.defaultCurrency).toBe("AUD");
  });

  it("refuses a malformed override before firing — the sidecar never sees it", async () => {
    const { controller, runTrigger } = build();

    const started = await controller.startRun({
      evaluationId: "tender-2026-water",
      stageSequence: ["chunk"],
      configOverride: { chunkMode: { chunkingModel: null, chunkSize: 0, chunkTables: true } },
    });

    expect(isErr(started)).toBe(true);
    if (!isErr(started)) return;
    expect(started.error.code).toBe("VALIDATION_FAILED");
    expect(runTrigger.started).toHaveLength(0);
  });

  it("surfaces a sidecar failure rather than throwing", async () => {
    const { controller, runTrigger } = build();
    runTrigger.startError = "womblex-ingest is unreachable";

    const started = await controller.startRun({
      evaluationId: "tender-2026-water",
      stageSequence: ["chunk"],
    });

    expect(isErr(started)).toBe(true);
    if (!isErr(started)) return;
    expect(started.error.code).toBe("INFRA_FAILURE");
  });
});

describe("CreateCorpusController — the whole create sequence", () => {
  it("stages every document, creates the evaluation, then triggers the run", async () => {
    const { controller, writer, createEvaluation, runTrigger } = build();

    const result = await controller.createCorpus({
      evaluation: createInput({
        documents: [
          { documentId: "acme-response.pdf", brand: "Acme" },
          { documentId: "beta-response.pdf", brand: "Beta" },
        ],
      }),
      uploads: [
        upload({ fileName: "acme-response.pdf" }),
        upload({ fileName: "beta-response.pdf" }),
      ],
      stageSequence: ["chunk", "embed", "enrich", "money"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.runId).toBe("run-1");
    expect(result.data.evaluationId).toBe("tender-2026-water");

    // Staged before created, created before triggered.
    expect(writer.staged.map((entry) => entry.upload.fileName)).toEqual([
      "acme-response.pdf",
      "beta-response.pdf",
    ]);
    expect(createEvaluation.inputs).toHaveLength(1);
    expect(runTrigger.started[0]?.evaluationId).toBe("tender-2026-water");
  });

  it("does not create or trigger when a document fails to stage", async () => {
    const { controller, writer, createEvaluation, runTrigger } = build();
    writer.rejectFileName = "beta-response.pdf";

    const result = await controller.createCorpus({
      evaluation: createInput(),
      uploads: [upload({ fileName: "acme-response.pdf" }), upload({ fileName: "beta-response.pdf" })],
      stageSequence: ["chunk"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
    expect(createEvaluation.inputs).toHaveLength(0);
    expect(runTrigger.started).toHaveLength(0);
  });

  it("does not trigger a run when the evaluation fails to create", async () => {
    const { controller, createEvaluation, runTrigger } = build();
    createEvaluation.error = "an evaluation already exists over corpus tender-2026-water";

    const result = await controller.createCorpus({
      evaluation: createInput(),
      uploads: [upload()],
      stageSequence: ["chunk"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(runTrigger.started).toHaveLength(0);
  });

  it("refuses a malformed override before staging anything", async () => {
    const { controller, writer, createEvaluation, runTrigger } = build();

    const result = await controller.createCorpus({
      evaluation: createInput(),
      uploads: [upload()],
      stageSequence: ["money"],
      configOverride: {
        moneyVocabulary: { extraHeaderTerms: [], extraVetoTerms: [], defaultCurrency: "dollars" },
      },
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(writer.staged).toHaveLength(0);
    expect(createEvaluation.inputs).toHaveLength(0);
    expect(runTrigger.started).toHaveLength(0);
  });
});
