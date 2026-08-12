import { describe, it, expect } from "vitest";
import type { StagedCorpus, StagedDocument } from "@redline/redline-domain";
import {
  renderCreateCorpusView,
  DEFAULT_STAGE_SEQUENCE,
  AUTHORABLE_STAGES,
  type CreateCorpusDraft,
} from "./create-corpus-view";

// The Create Corpus surface's view model (delivery-plan §2 item 1): a pure
// transform of the picker + form draft into the presentation shape the served
// route binds to — matching view.ts / run-status-view.ts, the DOM stays dumb and
// the readiness/affordance logic stays tested. It shows the four things the form
// authors: the document picker (a staged corpus and its documents), the
// evaluation name/id field, the allow-listed config overrides (stage sequence /
// chunk mode / money vocabulary — blank inherits the file default), and whether
// the trigger that drives ingest → lens → grouping → build is armed.

const corpus = (over: Partial<StagedCorpus> = {}): StagedCorpus => ({
  corpusId: "tender-2026-water",
  documentCount: 2,
  ...over,
});

const document = (over: Partial<StagedDocument> = {}): StagedDocument => ({
  documentId: "doc-1",
  chunkCount: 3,
  preview: "Response of Acme",
  ...over,
});

const draft = (over: Partial<CreateCorpusDraft> = {}): CreateCorpusDraft => ({
  corpora: [corpus()],
  selectedCorpusId: null,
  documents: [],
  selectedDocumentIds: [],
  evaluationName: "",
  stageSequence: DEFAULT_STAGE_SEQUENCE,
  chunkMode: null,
  moneyVocabulary: null,
  ...over,
});

describe("renderCreateCorpusView", () => {
  it("lists the staged corpora the picker chooses from", () => {
    const view = renderCreateCorpusView(draft({ corpora: [corpus(), corpus({ corpusId: "tender-it" })] }));

    expect(view.picker.corpora.map((option) => option.corpusId)).toEqual([
      "tender-2026-water",
      "tender-it",
    ]);
    expect(view.picker.corpora[0].label).toContain("2 document");
  });

  it("shows a corpus's documents with previews only once one is selected", () => {
    const unselected = renderCreateCorpusView(draft());
    expect(unselected.picker.documents).toEqual([]);

    const selected = renderCreateCorpusView(
      draft({
        selectedCorpusId: "tender-2026-water",
        documents: [document(), document({ documentId: "doc-2", preview: "Response of Beta" })],
        selectedDocumentIds: ["doc-1"],
      }),
    );
    expect(selected.picker.documents).toHaveLength(2);
    expect(selected.picker.documents[0].preview).toBe("Response of Acme");
    expect(selected.picker.documents[0].selected).toBe(true);
    expect(selected.picker.documents[1].selected).toBe(false);
  });

  it("offers every authorable stage as a toggle, defaulting to the full sequence", () => {
    const view = renderCreateCorpusView(draft());

    expect(view.config.stageSequence.stages.map((stage) => stage.stage)).toEqual([
      ...AUTHORABLE_STAGES,
    ]);
    expect(view.config.stageSequence.stages.every((stage) => stage.enabled)).toBe(true);
  });

  it("reflects a narrowed stage sequence — a corpus with no priced schedule drops money", () => {
    const view = renderCreateCorpusView(draft({ stageSequence: ["chunk", "embed"] }));

    const enabled = view.config.stageSequence.stages
      .filter((stage) => stage.enabled)
      .map((stage) => stage.stage);
    expect(enabled).toEqual(["chunk", "embed"]);
  });

  it("marks the chunk mode and money vocabulary as inheriting the file default when blank", () => {
    const view = renderCreateCorpusView(draft());

    expect(view.config.chunkMode.inheritsDefault).toBe(true);
    expect(view.config.moneyVocabulary.inheritsDefault).toBe(true);
  });

  it("marks an authored chunk mode as overriding the default", () => {
    const view = renderCreateCorpusView(
      draft({ chunkMode: { chunkingModel: null, chunkSize: 320, chunkTables: false } }),
    );

    expect(view.config.chunkMode.inheritsDefault).toBe(false);
    expect(view.config.chunkMode.chunkSize).toBe(320);
    expect(view.config.chunkMode.chunkTables).toBe(false);
    expect(view.config.chunkMode.aiChunking).toBe(false);
  });

  it("marks an AI/semantic chunking model as AI chunking", () => {
    const view = renderCreateCorpusView(
      draft({ chunkMode: { chunkingModel: "kanon-2-chunker", chunkSize: 480, chunkTables: true } }),
    );

    expect(view.config.chunkMode.aiChunking).toBe(true);
  });

  it("reflects authored money vocabulary as overriding the default", () => {
    const view = renderCreateCorpusView(
      draft({
        moneyVocabulary: {
          extraHeaderTerms: ["subtotal", "rrp"],
          extraVetoTerms: ["centre"],
          defaultCurrency: "AUD",
        },
      }),
    );

    expect(view.config.moneyVocabulary.inheritsDefault).toBe(false);
    expect(view.config.moneyVocabulary.extraHeaderTerms).toEqual(["subtotal", "rrp"]);
    expect(view.config.moneyVocabulary.defaultCurrency).toBe("AUD");
  });

  it("arms the trigger only once a name, a corpus and at least one document are chosen", () => {
    const empty = renderCreateCorpusView(draft());
    expect(empty.trigger.enabled).toBe(false);
    expect(empty.trigger.label).toBe("Choose a corpus, a document and a name to start");

    const named = renderCreateCorpusView(
      draft({
        selectedCorpusId: "tender-2026-water",
        documents: [document()],
        selectedDocumentIds: ["doc-1"],
        evaluationName: "Water treatment panel 2026",
      }),
    );
    expect(named.trigger.enabled).toBe(true);
    expect(named.trigger.label).toBe("Start run");
  });

  it("keeps the trigger disarmed while a name is present but no document is selected", () => {
    const view = renderCreateCorpusView(
      draft({
        selectedCorpusId: "tender-2026-water",
        documents: [document()],
        selectedDocumentIds: [],
        evaluationName: "Water treatment panel 2026",
      }),
    );

    expect(view.trigger.enabled).toBe(false);
  });

  it("disarms the trigger when the stage sequence is empty — a run must name a stage", () => {
    const view = renderCreateCorpusView(
      draft({
        selectedCorpusId: "tender-2026-water",
        documents: [document()],
        selectedDocumentIds: ["doc-1"],
        evaluationName: "Water treatment panel 2026",
        stageSequence: [],
      }),
    );

    expect(view.trigger.enabled).toBe(false);
    expect(view.trigger.label).toBe("Select at least one stage to run");
  });
});
