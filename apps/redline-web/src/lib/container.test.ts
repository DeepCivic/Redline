import { describe, it, expect } from "vitest";
import { isOk } from "@redline/redline-domain";
import { CorpusController } from "./container";
import {
  stagedCorpusReader,
  FakeStagedCorpusWriter,
  FakeRunTrigger,
} from "./container-test-fixtures";

// CorpusController end to end over the shared in-memory harness
// (container-test-fixtures.ts). The controller is deliberately thin — it reads
// the staged corpora a run has already landed and hands out the two run-side
// controllers — so what is worth proving here is that each seam is reached and
// that a seam error rides back as a Result rather than being thrown.

const controller = () =>
  new CorpusController({
    stagedCorpusReader,
    stagedCorpusWriter: new FakeStagedCorpusWriter(),
    runTrigger: new FakeRunTrigger(),
  });

describe("CorpusController — the staged-corpus reads", () => {
  it("lists the corpora a run has already staged", async () => {
    const listed = await controller().listStagedCorpora();

    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.data).toEqual([{ corpusId: "tender-2026", documentCount: 2 }]);
  });

  it("lists one corpus's documents", async () => {
    const listed = await controller().listStagedDocuments({ corpusId: "tender-2026" });

    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.data.map((document) => document.documentId)).toEqual(["doc-1", "doc-2"]);
  });

  it("returns the reader's NOT_FOUND for a corpus no run has staged", async () => {
    const listed = await controller().listStagedDocuments({ corpusId: "never-ran" });

    expect(isOk(listed)).toBe(false);
    if (isOk(listed)) return;
    expect(listed.error.code).toBe("NOT_FOUND");
  });
});

describe("CorpusController — the run-side controllers", () => {
  it("stages a document and fires a run through the corpus controller", async () => {
    const stagedCorpusWriter = new FakeStagedCorpusWriter();
    const runTrigger = new FakeRunTrigger();
    const corpusController = new CorpusController({
      stagedCorpusReader,
      stagedCorpusWriter,
      runTrigger,
    });

    const created = await corpusController.corpus().createCorpus({
      runName: "tender-2026",
      uploads: [{ fileName: "acme.pdf", contentType: "application/pdf", bytes: new Uint8Array([1]) }],
      stageSequence: ["extraction"],
    });

    expect(isOk(created)).toBe(true);
    expect(stagedCorpusWriter.staged.map((entry) => entry.upload.fileName)).toEqual(["acme.pdf"]);
    expect(runTrigger.started).toHaveLength(1);
  });

  it("polls a run through the run-status controller", async () => {
    const runTrigger = new FakeRunTrigger();
    runTrigger.nextStatus = {
      runId: "run-1",
      evaluationId: "tender-2026",
      phase: "extracting",
      completedStages: [],
      failedStage: null,
      resumable: false,
      error: null,
    };
    const corpusController = new CorpusController({
      stagedCorpusReader,
      stagedCorpusWriter: new FakeStagedCorpusWriter(),
      runTrigger,
    });

    const polled = await corpusController.runStatus().poll({ runId: "run-1" });

    expect(isOk(polled)).toBe(true);
    if (!isOk(polled)) return;
    expect(polled.data.statusLabel).toBe("Extracting documents");
    expect(polled.data.isRunning).toBe(true);
  });
});
