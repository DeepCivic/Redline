import { describe, it, expect, vi } from "vitest";
import { isOk, isErr, ok, err, domainError, makeEvaluation } from "@redline/redline-domain";
import type { IProcurementExtractionReader } from "@redline/redline-domain";
import { WorkflowController } from "./container";
import {
  InMemoryRepository,
  classifier,
  extractionReader,
  financialExtractor,
  languageModel,
  lensWriter,
  runTrigger,
  stagedCorpusReader,
  stagedCorpusWriter,
} from "./container-test-fixtures";

// WorkflowController end to end over the shared in-memory harness
// (container-test-fixtures.ts). The buildContainer factory's cold-start and
// money-span wiring lives in container-wiring.test.ts, so this file stays on the
// controller's own behaviour: grouping, classifying, review, provenance, create.

const controllerAt = (stage: Parameters<typeof makeEvaluation>[0]["stage"]) => {
  const repository = new InMemoryRepository();
  const evaluation = makeEvaluation({ id: "eval-1", name: "Tender 2026", stage });
  if (isErr(evaluation)) throw new Error("bad seed");
  repository.seed(evaluation.data);
  const controller = new WorkflowController({
    repository,
    classifier,
    financialExtractor,
    extractionReader,
    languageModel,
    stagedCorpusReader,
    lensWriter,
    stagedCorpusWriter,
    runTrigger,
    productName: "Platform",
  });
  return { repository, controller };
};

describe("WorkflowController — grouping", () => {
  it("opens a manager for an evaluation and reports its documents unassigned", async () => {
    const { controller } = controllerAt("grouping");
    const opened = await controller.openWorkflow({
      evaluationId: "eval-1",
      documentIds: ["doc-1", "doc-2"],
    });
    expect(isOk(opened)).toBe(true);
    if (!isOk(opened)) return;
    expect(opened.data.snapshot().unassignedDocumentIds).toEqual(["doc-1", "doc-2"]);
  });

  it("persists the composed groups and advances grouping → classifying", async () => {
    const { controller, repository } = controllerAt("grouping");
    const opened = await controller.openWorkflow({
      evaluationId: "eval-1",
      documentIds: ["doc-1", "doc-2"],
    });
    if (!isOk(opened)) throw new Error("open failed");
    const manager = opened.data;
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-acme", label: "Acme Bid", vendorIds: ["v-acme"] });
    manager.assignDocument("g-acme", "doc-1");
    manager.assignDocument("g-acme", "doc-2");

    const advanced = await controller.advance(manager);
    expect(isOk(advanced)).toBe(true);
    if (!isOk(advanced)) return;
    expect(advanced.data.stage).toBe("classifying");

    const stored = await repository.listResponseGroups("eval-1");
    if (!isOk(stored)) throw new Error("no groups");
    expect(stored.data).toHaveLength(1);
    expect(stored.data[0].documentIds).toEqual(["doc-1", "doc-2"]);
  });

  it("refuses to advance an empty composition", async () => {
    const { controller } = controllerAt("grouping");
    const opened = await controller.openWorkflow({ evaluationId: "eval-1", documentIds: ["doc-1"] });
    if (!isOk(opened)) throw new Error("open failed");
    const manager = opened.data;
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-acme", label: "Acme Bid", vendorIds: ["v-acme"] });

    const advanced = await controller.advance(manager);
    expect(isErr(advanced)).toBe(true);
  });
});

describe("WorkflowController — classifying", () => {
  it("re-runs classification for a single group without advancing", async () => {
    const { controller } = controllerAt("classifying");
    const result = await controller.reclassifyGroup({
      evaluationId: "eval-1",
      responseGroupId: "g-acme",
      documentIds: ["doc-1"],
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0].requirementId).toBe("req-1");
  });

  it("builds the evaluation table and advances classifying → review", async () => {
    const { controller, repository } = controllerAt("classifying");
    // A group must exist for BuildEvaluationTable to walk.
    await repository.saveVendor("eval-1", {
      id: "v-acme",
      displayName: "Acme",
      isConsortium: false,
      memberVendorIds: [],
    });
    await repository.saveResponseGroup({
      id: "g-acme",
      evaluationId: "eval-1",
      vendorIds: ["v-acme"],
      label: "Acme Bid",
      documentIds: ["doc-1"],
      isConsortiumResponse: false,
    });

    const built = await controller.buildTable({ evaluationId: "eval-1" });
    expect(isOk(built)).toBe(true);
    if (!isOk(built)) return;
    expect(built.data).toHaveLength(1);
    expect(built.data[0].vendorName).toBe("Acme");
    expect(built.data[0].costing.estimateAud).toBe(1000);

    const evaluation = await repository.findEvaluation("eval-1");
    if (!isOk(evaluation)) throw new Error("gone");
    expect(evaluation.data.stage).toBe("review");
  });
});

describe("WorkflowController — the way in", () => {
  it("lists the evaluations a specialist can open, newest first", async () => {
    const { controller, repository } = controllerAt("review");
    const second = makeEvaluation({ id: "eval-2", name: "Panel refresh", stage: "grouping" });
    if (isErr(second)) throw new Error("bad seed");
    repository.seed(second.data);

    const listed = await controller.listEvaluations();
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.data).toEqual([
      { id: "eval-2", name: "Panel refresh", stage: "grouping" },
      { id: "eval-1", name: "Tender 2026", stage: "review" },
    ]);
  });

  it("surfaces the repository's failure rather than throwing across the port", async () => {
    const failing = new InMemoryRepository();
    failing.listEvaluations = async () =>
      err(domainError("INFRA_FAILURE", "failed to list evaluations"));
    const controller = new WorkflowController({
      repository: failing,
      classifier,
      financialExtractor,
      extractionReader,
      languageModel,
      stagedCorpusReader,
      lensWriter,
      stagedCorpusWriter,
      runTrigger,
      productName: "Platform",
    });

    const listed = await controller.listEvaluations();
    expect(isErr(listed)).toBe(true);
    if (!isErr(listed)) return;
    expect(listed.error.code).toBe("INFRA_FAILURE");
  });
});

describe("WorkflowController — review", () => {
  it("opens a review grid over the persisted responses (currency stays numeric)", async () => {
    const { controller, repository } = controllerAt("review");
    await repository.saveResponses([
      {
        evaluationId: "eval-1",
        responseGroupId: "g-acme",
        vendorName: "Acme",
        productName: "Platform",
        requirementId: "req-1",
        confidence: 0.9,
        productSummary: "A concise summary.",
        costing: { estimateAud: 1500.5, description: "" },
        source: { documentId: "doc-1", elementOrder: 7, page: 3, chunkId: "doc-1:2" },
      },
    ]);

    const opened = await controller.openReviewGrid({ evaluationId: "eval-1" });
    expect(isOk(opened)).toBe(true);
    if (!isOk(opened)) return;

    const rows = opened.data.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.vendorName.display).toBe("Acme");
    expect(rows[0].cells.estimateAud.isNumeric).toBe(true);
    expect(rows[0].cells.estimateAud.sortValue).toBe(1500.5);
    expect(rows[0].source.documentId).toBe("doc-1");
  });

  it("opens an empty review grid when no responses were built yet", async () => {
    const { controller } = controllerAt("review");
    const opened = await controller.openReviewGrid({ evaluationId: "eval-1" });
    expect(isOk(opened)).toBe(true);
    if (!isOk(opened)) return;
    expect(opened.data.all()).toEqual([]);
  });

  it("opens a pricing pivot over the persisted responses and rolls up per brand", async () => {
    const { controller, repository } = controllerAt("review");
    await repository.saveResponses([
      {
        evaluationId: "eval-1",
        responseGroupId: "g-acme",
        vendorName: "Acme",
        productName: "Platform",
        requirementId: "req-1",
        confidence: 0.9,
        productSummary: "A concise summary.",
        costing: { estimateAud: 1000, description: "" },
        source: { documentId: "doc-1", elementOrder: 7, page: 3, chunkId: "doc-1:2" },
      },
      {
        evaluationId: "eval-1",
        responseGroupId: "g-acme",
        vendorName: "Acme",
        productName: "Platform",
        requirementId: "req-2",
        confidence: 0.8,
        productSummary: "A concise summary.",
        costing: { estimateAud: 500, description: "" },
        source: { documentId: "doc-1", elementOrder: 9, page: 4, chunkId: "doc-1:3" },
      },
    ]);

    const opened = await controller.openPricingPivot({ evaluationId: "eval-1" });
    expect(isOk(opened)).toBe(true);
    if (!isOk(opened)) return;

    const result = opened.data.compute({ axis: "brand", measure: "sum" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].key).toBe("Acme");
    expect(result.rows[0].total.value).toBe(1500);
    expect(result.grandTotal.value).toBe(1500);
  });

  it("builds the export workbook over the persisted responses (numeric currency + source links)", async () => {
    const { controller, repository } = controllerAt("review");
    await repository.saveResponses([
      {
        evaluationId: "eval-1",
        responseGroupId: "g-acme",
        vendorName: "Acme",
        productName: "Platform",
        requirementId: "req-1",
        confidence: 0.9,
        productSummary: "A concise summary.",
        costing: { estimateAud: 1500.5, description: "" },
        source: { documentId: "doc-1", elementOrder: 7, page: 3, chunkId: "doc-1:2" },
      },
    ]);

    const built = await controller.buildWorkbook({ evaluationId: "eval-1" });
    expect(isOk(built)).toBe(true);
    if (!isOk(built)) return;

    // One review sheet + one per pivot.
    expect(built.data.sheetNames).toEqual([
      "Review",
      "Pricing by Vendor",
      "Pricing by Requirement",
      "Vendor × Requirement",
    ]);

    // The review sheet's first body row: numeric estimate + a source hyperlink.
    const reviewBody = built.data.sheets[0][1]!;
    expect(reviewBody[5]).toEqual({ value: 1500.5, type: Number });
    expect(reviewBody[7]).toMatchObject({
      hyperlink: "/evaluations/eval-1/documents/doc-1?element=7&page=3&chunk=doc-1%3A2",
    });
  });

  it("builds an empty workbook when no responses were built yet", async () => {
    const { controller } = controllerAt("review");
    const built = await controller.buildWorkbook({ evaluationId: "eval-1" });
    expect(isOk(built)).toBe(true);
    if (!isOk(built)) return;
    // Every sheet still carries its header row.
    expect(built.data.sheets[0]).toHaveLength(1);
    expect(built.data.sheets[0][0][0]).toEqual({ value: "Vendor", type: String, fontWeight: "bold" });
  });
});

// The other end of the review grid's source deep-link.
// openDocument reads one document's elements through IProcurementExtractionReader
// — the JSON presentation seam of ADR-0003/0017 — so the served route has
// something to anchor the `element` query parameter on. Read side only.
describe("WorkflowController — document provenance", () => {
  const controllerReading = (reader: IProcurementExtractionReader) => {
    const repository = new InMemoryRepository();
    const evaluation = makeEvaluation({ id: "eval-1", name: "Tender 2026", stage: "review" });
    if (isErr(evaluation)) throw new Error("bad seed");
    repository.seed(evaluation.data);
    return new WorkflowController({
      repository,
      classifier,
      financialExtractor,
      extractionReader: reader,
      languageModel,
      stagedCorpusReader,
      lensWriter,
      stagedCorpusWriter,
      runTrigger,
      productName: "Platform",
    });
  };

  it("reads the cited document's elements through the extraction reader", async () => {
    const readElements = vi.fn(async () =>
      ok([
        { documentId: "doc-1", elementOrder: 7, page: 3, text: "the cited passage" },
        { documentId: "doc-1", elementOrder: 2, page: 1, text: "an earlier paragraph" },
      ]),
    );
    const controller = controllerReading({
      readElements,
      readChunks: async () => ok([]),
      readTableCells: async () => ok([]),
    });

    const opened = await controller.openDocument({ evaluationId: "eval-1", documentId: "doc-1" });
    expect(isOk(opened)).toBe(true);
    if (!isOk(opened)) return;

    expect(readElements).toHaveBeenCalledWith("eval-1", "doc-1");
    expect(opened.data.map((element) => element.elementOrder)).toEqual([7, 2]);
  });

  it("surfaces the reader's failure rather than throwing across the port", async () => {
    const controller = controllerReading({
      readElements: async () => err(domainError("INFRA_FAILURE", "womblex-ingest is unreachable")),
      readChunks: async () => ok([]),
      readTableCells: async () => ok([]),
    });

    const opened = await controller.openDocument({ evaluationId: "eval-1", documentId: "doc-1" });
    expect(isErr(opened)).toBe(true);
    if (!isErr(opened)) return;
    expect(opened.error.code).toBe("INFRA_FAILURE");
  });

  it("returns an empty element list for a document the extraction carries nothing for", async () => {
    const controller = controllerReading({
      readElements: async () => ok([]),
      readChunks: async () => ok([]),
      readTableCells: async () => ok([]),
    });

    const opened = await controller.openDocument({ evaluationId: "eval-1", documentId: "doc-9" });
    expect(isOk(opened)).toBe(true);
    if (!isOk(opened)) return;
    expect(opened.data).toEqual([]);
  });
});

describe("WorkflowController — creating an evaluation from a staged corpus", () => {
  const emptyController = () =>
    new WorkflowController({
      repository: new InMemoryRepository(),
      classifier,
      financialExtractor,
      extractionReader,
      languageModel,
      stagedCorpusReader,
      lensWriter,
      stagedCorpusWriter,
      runTrigger,
      productName: "Platform",
    });

  it("offers the staged corpora the create screen picks from", async () => {
    const corpora = await emptyController().listStagedCorpora();

    expect(isOk(corpora)).toBe(true);
    if (!isOk(corpora)) return;
    expect(corpora.data).toEqual([{ corpusId: "tender-2026", documentCount: 2 }]);
  });

  it("offers a corpus's documents with previews, so opaque hashes are choosable", async () => {
    const documents = await emptyController().listStagedDocuments({ corpusId: "tender-2026" });

    expect(isOk(documents)).toBe(true);
    if (!isOk(documents)) return;
    expect(documents.data.map((document) => document.preview)).toEqual([
      "Response of Acme",
      "Response of Beta",
    ]);
  });

  it("creates the evaluation under the corpus's own id and lists it", async () => {
    const controller = emptyController();

    const created = await controller.createEvaluation({
      corpusId: "tender-2026",
      name: "Panel 2026",
      documents: [{ documentId: "doc-1", brand: "Acme" }],
      fields: [{ name: "Warranty", definition: "The warranty offered." }],
    });

    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.data.id).toBe("tender-2026");

    const listed = await controller.listEvaluations();
    if (!isOk(listed)) throw new Error("list failed");
    expect(listed.data.map((evaluation) => evaluation.id)).toEqual(["tender-2026"]);
  });

  it("refuses a corpus nothing has staged", async () => {
    const created = await emptyController().createEvaluation({
      corpusId: "never-staged",
      name: "Panel 2026",
      documents: [{ documentId: "doc-1", brand: "Acme" }],
      fields: [{ name: "Warranty", definition: "The warranty offered." }],
    });

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("NOT_FOUND");
  });
});
