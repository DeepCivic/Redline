import { describe, it, expect } from "vitest";
import {
  isErr,
  isOk,
  ok,
  err,
  domainError,
  type IStagedCorpusWriter,
  type IWomblexRunTrigger,
  type Result,
  type RunStatusView,
  type StagedUpload,
  type TriggerRunRequest,
} from "@redline/redline-domain";
import { CreateCorpusController } from "./create-corpus-controller";

// The Create Corpus controller is the ingest surface's write brain: it owns the
// two seams the served container gained — the object-store writer
// (IStagedCorpusWriter, staging a specialist's bytes under the run's input
// prefix) and the run trigger (IWomblexRunTrigger, firing the pass sequence
// against the authored config).
//
// It does NOT create an evaluation. womblex is a cold-start engine: raw
// documents go under the run's input prefix, the run extracts them and mints
// their source_hash identities, and only then can an evaluation name brands and
// fields against real documents. Creating one here is what forced a specialist
// to describe documents the run had not yet read, and it is why the surface
// could only ever re-run a corpus something else had extracted.
// /evaluations/new composes the evaluation afterwards.

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

const upload = (over: Partial<StagedUpload> = {}): StagedUpload => ({
  fileName: "acme-response.pdf",
  bytes: new Uint8Array([1, 2, 3]),
  contentType: "application/pdf",
  ...over,
});

const build = () => {
  const writer = new FakeStagedCorpusWriter();
  const runTrigger = new FakeRunTrigger();
  const controller = new CreateCorpusController({ writer, runTrigger });
  return { writer, runTrigger, controller };
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

  it("carries an extraction-only override — the other two groups blank must not drop it", async () => {
    const { controller, runTrigger } = build();

    const started = await controller.startRun({
      evaluationId: "tender-2026-water",
      stageSequence: ["chunk"],
      configOverride: { extraction: { ocrEngine: "mistral-ocr", ocrDpi: 400 } },
    });

    expect(isOk(started)).toBe(true);
    // An override is "absent" only when every group is blank. Counting the two
    // original groups alone would silently discard a run that authored nothing
    // but its OCR engine — the exact drop this seam exists to close.
    expect(runTrigger.started[0]?.configOverride?.extraction?.ocrEngine).toBe("mistral-ocr");
    expect(runTrigger.started[0]?.configOverride?.extraction?.ocrDpi).toBe(400);
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

describe("CreateCorpusController — the whole ingest sequence", () => {
  it("stages every document under the run's own name, then fires the run", async () => {
    const { controller, writer, runTrigger } = build();

    const result = await controller.createCorpus({
      runName: "tender-2026-water",
      uploads: [
        upload({ fileName: "acme-response.pdf" }),
        upload({ fileName: "beta-response.pdf" }),
      ],
      stageSequence: ["chunk", "embed", "enrich", "money"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.runId).toBe("run-1");
    expect(result.data.corpusId).toBe("tender-2026-water");

    // The name the specialist typed is the run, the object-store prefix and the
    // corpus id — one identity, staged before fired.
    expect(writer.staged.map((entry) => entry.evaluationId)).toEqual([
      "tender-2026-water",
      "tender-2026-water",
    ]);
    expect(writer.staged.map((entry) => entry.upload.fileName)).toEqual([
      "acme-response.pdf",
      "beta-response.pdf",
    ]);
    expect(runTrigger.started[0]?.evaluationId).toBe("tender-2026-water");
  });

  it("does not fire the run when a document fails to stage", async () => {
    const { controller, writer, runTrigger } = build();
    writer.rejectFileName = "beta-response.pdf";

    const result = await controller.createCorpus({
      runName: "tender-2026-water",
      uploads: [
        upload({ fileName: "acme-response.pdf" }),
        upload({ fileName: "beta-response.pdf" }),
      ],
      stageSequence: ["chunk"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
    // A run over a half-staged prefix would extract some of the corpus and
    // report success, which is worse than not starting.
    expect(runTrigger.started).toHaveLength(0);
  });

  it("trims the run name, so a stray space cannot make a second prefix", async () => {
    const { controller, writer, runTrigger } = build();

    const result = await controller.createCorpus({
      runName: "  tender-2026-water  ",
      uploads: [upload()],
      stageSequence: ["chunk"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.corpusId).toBe("tender-2026-water");
    expect(writer.staged[0]?.evaluationId).toBe("tender-2026-water");
    expect(runTrigger.started[0]?.evaluationId).toBe("tender-2026-water");
  });

  it("refuses a blank run name before staging anything", async () => {
    const { controller, writer, runTrigger } = build();

    const result = await controller.createCorpus({
      runName: "   ",
      uploads: [upload()],
      stageSequence: ["chunk"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(writer.staged).toHaveLength(0);
    expect(runTrigger.started).toHaveLength(0);
  });

  it("refuses a run with no documents — the engine refuses an empty prefix anyway", async () => {
    const { controller, runTrigger } = build();

    const result = await controller.createCorpus({
      runName: "tender-2026-water",
      uploads: [],
      stageSequence: ["chunk"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(runTrigger.started).toHaveLength(0);
  });

  it("refuses a malformed override before staging anything", async () => {
    const { controller, writer, runTrigger } = build();

    const result = await controller.createCorpus({
      runName: "tender-2026-water",
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
    expect(runTrigger.started).toHaveLength(0);
  });
});
