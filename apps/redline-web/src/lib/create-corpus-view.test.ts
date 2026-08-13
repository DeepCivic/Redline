import { describe, it, expect } from "vitest";
import {
  renderCreateCorpusView,
  DEFAULT_STAGE_SEQUENCE,
  AUTHORABLE_STAGES,
  type CreateCorpusDraft,
  type PendingUpload,
} from "./create-corpus-view";

// The Create Corpus surface's view model: a pure transform of the ingest draft
// into the presentation shape the served route binds to — matching view.ts /
// run-status-view.ts, the DOM stays dumb and the readiness logic stays tested.
//
// This is an *ingest* surface. It authors three things: the run name (which is
// the womblex run, the object-store prefix and later the evaluation id — one
// identity, and the engine's to mint, so nothing here curates it), the documents
// to upload into that run's input prefix, and the allow-listed config overrides.
// It does not name brands or fields and does not create an evaluation: raw
// documents in, evaluation composed afterwards on /evaluations/new, in that
// order. A surface that picked an already-extracted corpus could only ever
// re-run something else had extracted, which is the case womblex is not for.

const upload = (over: Partial<PendingUpload> = {}): PendingUpload => ({
  fileName: "acme-response.pdf",
  sizeBytes: 2048,
  contentType: "application/pdf",
  ...over,
});

const draft = (over: Partial<CreateCorpusDraft> = {}): CreateCorpusDraft => ({
  runName: "",
  uploads: [],
  stageSequence: DEFAULT_STAGE_SEQUENCE,
  chunkMode: null,
  moneyVocabulary: null,
  extraction: null,
  ...over,
});

describe("renderCreateCorpusView", () => {
  it("lists the documents queued for upload, in the order they were chosen", () => {
    const view = renderCreateCorpusView(
      draft({ uploads: [upload(), upload({ fileName: "beta-response.pdf" })] }),
    );

    expect(view.uploads.rows.map((row) => row.fileName)).toEqual([
      "acme-response.pdf",
      "beta-response.pdf",
    ]);
    expect(view.uploads.summary).toBe("2 documents to upload");
  });

  it("reports an empty upload list as the thing still missing", () => {
    const view = renderCreateCorpusView(draft());

    expect(view.uploads.rows).toEqual([]);
    expect(view.uploads.summary).toBe("No documents chosen yet");
  });

  it("renders each document's size so a specialist can spot a wrong file", () => {
    const view = renderCreateCorpusView(
      draft({
        uploads: [
          upload({ fileName: "small.pdf", sizeBytes: 512 }),
          upload({ fileName: "large.pdf", sizeBytes: 3_670_016 }),
        ],
      }),
    );

    expect(view.uploads.rows[0].sizeLabel).toBe("512 B");
    expect(view.uploads.rows[1].sizeLabel).toBe("3.5 MB");
  });

  it("passes the run name through untouched — the engine owns that identity", () => {
    const view = renderCreateCorpusView(draft({ runName: "tender-2026-water" }));

    expect(view.runName).toBe("tender-2026-water");
  });

  it("arms the trigger once a run has a name, a document and a stage", () => {
    const view = renderCreateCorpusView(
      draft({ runName: "tender-2026-water", uploads: [upload()] }),
    );

    expect(view.trigger.enabled).toBe(true);
    expect(view.trigger.label).toBe("Start run");
  });

  it("refuses to arm without a name, and says so", () => {
    const view = renderCreateCorpusView(draft({ runName: "   ", uploads: [upload()] }));

    expect(view.trigger.enabled).toBe(false);
    expect(view.trigger.label).toBe("Name the run and choose documents to start");
  });

  it("refuses to arm without a document", () => {
    const view = renderCreateCorpusView(draft({ runName: "tender-2026-water" }));

    expect(view.trigger.enabled).toBe(false);
    expect(view.trigger.label).toBe("Name the run and choose documents to start");
  });

  it("refuses to arm with every stage switched off", () => {
    const view = renderCreateCorpusView(
      draft({ runName: "tender-2026-water", uploads: [upload()], stageSequence: [] }),
    );

    expect(view.trigger.enabled).toBe(false);
    expect(view.trigger.label).toBe("Select at least one stage to run");
  });

  it("offers every authorable stage, flagging the ones the draft has on", () => {
    const view = renderCreateCorpusView(draft({ stageSequence: ["chunk", "money"] }));

    expect(view.config.stageSequence.stages.map((toggle) => toggle.stage)).toEqual([
      ...AUTHORABLE_STAGES,
    ]);
    const enabled = view.config.stageSequence.stages
      .filter((toggle) => toggle.enabled)
      .map((toggle) => toggle.stage);
    expect(enabled).toEqual(["chunk", "money"]);
  });

  it("shows a blank override group as inheriting the redline.yaml default", () => {
    const view = renderCreateCorpusView(draft());

    expect(view.config.chunkMode.inheritsDefault).toBe(true);
    expect(view.config.chunkMode.chunkSize).toBeNull();
    expect(view.config.moneyVocabulary.inheritsDefault).toBe(true);
    expect(view.config.moneyVocabulary.defaultCurrency).toBeNull();
    expect(view.config.extraction.inheritsDefault).toBe(true);
    expect(view.config.extraction.ocrEngine).toBeNull();
    expect(view.config.extraction.ocrDpi).toBeNull();
  });

  it("shows an authored override group as the specialist's, not the file's", () => {
    const view = renderCreateCorpusView(
      draft({
        chunkMode: { chunkingModel: null, chunkSize: 640, chunkTables: false },
        moneyVocabulary: {
          extraHeaderTerms: ["schedule of rates"],
          extraVetoTerms: ["page"],
          defaultCurrency: "AUD",
        },
      }),
    );

    expect(view.config.chunkMode.inheritsDefault).toBe(false);
    expect(view.config.chunkMode.aiChunking).toBe(false);
    expect(view.config.chunkMode.chunkSize).toBe(640);
    expect(view.config.moneyVocabulary.inheritsDefault).toBe(false);
    expect(view.config.moneyVocabulary.extraHeaderTerms).toEqual(["schedule of rates"]);
    expect(view.config.moneyVocabulary.defaultCurrency).toBe("AUD");
  });

  it("flags an AI chunking model, because it changes what the run costs", () => {
    const view = renderCreateCorpusView(
      draft({
        chunkMode: { chunkingModel: "kanon-2", chunkSize: 480, chunkTables: true },
      }),
    );

    expect(view.config.chunkMode.aiChunking).toBe(true);
    expect(view.config.chunkMode.chunkingModel).toBe("kanon-2");
  });

  it("shows an authored extraction group as the specialist's OCR engine and dpi", () => {
    const view = renderCreateCorpusView(
      draft({ extraction: { ocrEngine: "mistral-ocr", ocrDpi: 400 } }),
    );

    expect(view.config.extraction.inheritsDefault).toBe(false);
    expect(view.config.extraction.ocrEngine).toBe("mistral-ocr");
    expect(view.config.extraction.ocrDpi).toBe(400);
  });
});
