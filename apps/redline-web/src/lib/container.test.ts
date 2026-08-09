import { describe, it, expect, vi } from "vitest";
import { isOk, isErr, ok, err, domainError, makeEvaluation, makeHardRuleSet } from "@redline/redline-domain";
import type {
  Adjudication,
  AdjudicationRequest,
  ChunkRow,
  ClassificationLens,
  Evaluation,
  HardRuleCandidate,
  HardRuleSet,
  IAdjudicator,
  IChunkStore,
  IClassificationLensReader,
  IClassificationLensWriter,
  IEvaluationRepository,
  IFinancialExtractor,
  ILanguageModel,
  IMoneySpanStore,
  IProcurementClassifier,
  IProcurementExtractionReader,
  IStagedCorpusReader,
  MoneySpanFilter,
  MoneySpanRow,
  ProcurementResponse,
  Result,
  ResponseGroup,
  ScoredChunkRef,
  StructureFilter,
  Topic,
  Vendor,
} from "@redline/redline-domain";
import {
  WorkflowController,
  buildColdStartClassifier,
  buildContainer,
  buildMoneySpanFinancialExtractor,
} from "./container";

// A small in-memory repository so the controller can be exercised end to end
// without a database — the same standalone posture as the application tests.
class InMemoryRepository implements IEvaluationRepository {
  private evaluations = new Map<string, Evaluation>();
  private vendors = new Map<string, Vendor[]>();
  private groups = new Map<string, ResponseGroup[]>();
  private responses = new Map<string, ProcurementResponse[]>();

  seed(evaluation: Evaluation) {
    this.evaluations.set(evaluation.id, evaluation);
  }

  async saveEvaluation(evaluation: Evaluation) {
    this.evaluations.set(evaluation.id, evaluation);
    return ok(evaluation);
  }
  async findEvaluation(evaluationId: string) {
    const found = this.evaluations.get(evaluationId);
    return found ? ok(found) : err(domainError("NOT_FOUND", `no evaluation ${evaluationId}`));
  }
  async saveVendor(evaluationId: string, vendor: Vendor) {
    const list = this.vendors.get(evaluationId) ?? [];
    this.vendors.set(evaluationId, [...list.filter((v) => v.id !== vendor.id), vendor]);
    return ok(vendor);
  }
  async listVendors(evaluationId: string) {
    return ok(this.vendors.get(evaluationId) ?? []);
  }
  async saveResponseGroup(group: ResponseGroup) {
    const list = this.groups.get(group.evaluationId) ?? [];
    this.groups.set(group.evaluationId, [...list.filter((g) => g.id !== group.id), group]);
    return ok(group);
  }
  async listResponseGroups(evaluationId: string) {
    return ok(this.groups.get(evaluationId) ?? []);
  }
  async saveResponses(responses: readonly ProcurementResponse[]) {
    for (const response of responses) {
      const list = this.responses.get(response.evaluationId) ?? [];
      this.responses.set(response.evaluationId, [...list, response]);
    }
    return ok(responses);
  }
  async listResponses(evaluationId: string) {
    return ok(this.responses.get(evaluationId) ?? []);
  }
  async listEvaluations() {
    return ok([...this.evaluations.values()].reverse());
  }
}

const classifier: IProcurementClassifier = {
  async classifyResponseGroup(request) {
    return ok(
      request.documentIds.map((documentId) => ({
        documentId,
        requirementId: "req-1",
        confidence: 0.9,
        sourceChunkId: `${documentId}:0`,
      })),
    );
  },
};

const financialExtractor: IFinancialExtractor = {
  async extractFinancials(request) {
    return ok(
      request.documentIds.map((documentId) => ({
        documentId,
        requirementId: "req-1",
        elementOrder: 3,
        estimateAud: 1000,
        description: "",
      })),
    );
  },
};

const extractionReader: IProcurementExtractionReader = {
  async readElements() {
    return ok([]);
  },
  async readChunks() {
    return ok([{ chunkId: "c-1", documentId: "doc-1", text: "a matched passage" }]);
  },
  async readTableCells() {
    return ok([]);
  },
};

const languageModel: ILanguageModel = {
  async summarise() {
    return ok("A concise one-paragraph summary.");
  },
};

// The create half's two ports. The reader stands in for the rows the sidecar's
// load path writes, which is the only thing that makes a corpus selectable.
const stagedCorpusReader: IStagedCorpusReader = {
  async listCorpora() {
    return ok([{ corpusId: "tender-2026", documentCount: 2 }]);
  },
  async listDocuments(corpusId: string) {
    if (corpusId !== "tender-2026") {
      return err(domainError("NOT_FOUND", `no corpus staged under ${corpusId}`));
    }
    return ok([
      { documentId: "doc-1", chunkCount: 3, preview: "Response of Acme" },
      { documentId: "doc-2", chunkCount: 5, preview: "Response of Beta" },
    ]);
  },
};

const lensWriter: IClassificationLensWriter = {
  async saveLens() {
    return ok(undefined);
  },
};

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

// The other end of the review grid's source deep-link (delivery-plan item 1).
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

// The item-1b seam: buildColdStartClassifier composes the untrained first pass
// (hard rules + adjudication over exact fetch, no nearest-neighbour) into an
// ordinary IProcurementClassifier the container accepts as `parts.classifier`.
// This proves the cold-start path is wired *behind the port* — the controller,
// once built with it, reclassifies a group with no Numbatch and no trained
// adapter anywhere in the graph.
describe("container — cold-start classifier wiring (item 1b)", () => {
  const topics: readonly Topic[] = [
    { id: "req-support", name: "Support", definition: "support services" },
    { id: "req-hosting", name: "Hosting", definition: "hosting services" },
  ];

  // A store that answers the exact-fetch half and refuses the deferred
  // similarity half — the ADR-0018-addendum shape the cold-start path runs over.
  class FakeChunkStore implements IChunkStore {
    constructor(private readonly rows: readonly ChunkRow[]) {}
    async fetchChunks(
      _e: string,
      chunkIds: readonly string[],
    ): Promise<Result<readonly ChunkRow[]>> {
      return ok(
        chunkIds
          .map((id) => this.rows.find((r) => r.chunkId === id))
          .filter((r): r is ChunkRow => r !== undefined),
      );
    }
    async fetchByStructure(
      _e: string,
      filter: StructureFilter,
    ): Promise<Result<readonly ChunkRow[]>> {
      return ok(this.rows.filter((r) => !filter.documentId || r.documentId === filter.documentId));
    }
    async findSimilar(): Promise<Result<readonly ScoredChunkRef[]>> {
      return err(domainError("NOT_IMPLEMENTED", "deferred (ADR-0018 addendum)"));
    }
  }

  const adjudicator: IAdjudicator = {
    async adjudicate(request: AdjudicationRequest): Promise<Result<Adjudication>> {
      const verdict: Adjudication = {
        documentId: request.documentId,
        chosenTopicId: request.candidates[0].topicId,
        rationale: "chosen on the passages",
      };
      return ok(verdict);
    },
  };

  // The evaluation-scoped lens the classifier resolves per call. A fixed lens
  // stands in for the persisted one until DrizzleClassificationLensReader lands.
  const lensReaderFor = (
    ruleSet: HardRuleSet,
    candidates: readonly HardRuleCandidate[] = [],
  ): IClassificationLensReader => ({
    async readLens(): Promise<Result<ClassificationLens>> {
      return ok({ topics, ruleSet, candidates });
    },
  });

  it("reclassifies a group through a container wired with the cold-start path (no Numbatch)", async () => {
    const store = new FakeChunkStore([
      {
        documentId: "doc-1",
        chunkId: "doc-1:0",
        chunkIndex: 0,
        contentType: "narrative",
        page: 1,
        text: "we provide support",
      },
    ]);
    const ruleSet = makeHardRuleSet({ rules: [] });
    if (isErr(ruleSet)) throw new Error("bad rules");

    const coldStart = buildColdStartClassifier({
      chunkStore: store,
      adjudicator,
      lensReader: lensReaderFor(ruleSet.data),
    });

    const repository = new InMemoryRepository();
    const evaluation = makeEvaluation({ id: "eval-1", name: "Tender", stage: "classifying" });
    if (isErr(evaluation)) throw new Error("bad seed");
    repository.seed(evaluation.data);

    const container = buildContainer({
      repository,
      classifier: coldStart,
      financialExtractor,
      extractionReader,
      languageModel,
      stagedCorpusReader,
      lensWriter,
      productName: "Platform",
    });
    expect(isOk(container)).toBe(true);
    if (!isOk(container)) return;

    const controller = new WorkflowController(container.data);
    const result = await controller.reclassifyGroup({
      evaluationId: "eval-1",
      responseGroupId: "g-acme",
      documentIds: ["doc-1"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      documentId: "doc-1",
      requirementId: "req-support",
      sourceChunkId: "doc-1:0",
    });
  });

  it("resolves a hard-rule-claimed document through the wired path without the model", async () => {
    let modelCalls = 0;
    const recordingAdjudicator: IAdjudicator = {
      async adjudicate(request: AdjudicationRequest): Promise<Result<Adjudication>> {
        modelCalls += 1;
        return ok({
          documentId: request.documentId,
          chosenTopicId: request.candidates[0].topicId,
          rationale: "",
        });
      },
    };
    const ruleSet = makeHardRuleSet({
      rules: [{ id: "r1", pattern: "SEC-*", topicId: "req-support" }],
    });
    if (isErr(ruleSet)) throw new Error("bad rules");

    const coldStart = buildColdStartClassifier({
      chunkStore: new FakeChunkStore([]),
      adjudicator: recordingAdjudicator,
      lensReader: lensReaderFor(ruleSet.data, [{ documentId: "SEC-014", subjects: ["SEC-014"] }]),
    });

    const result = await coldStart.classifyResponseGroup({
      evaluationId: "eval-1",
      responseGroupId: "g",
      documentIds: ["SEC-014"],
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0].requirementId).toBe("req-support");
    expect(result.data[0].sourceChunkId).toBeNull();
    expect(modelCalls).toBe(0);
  });
});

// The delivery-plan §2 item 1 seam: buildMoneySpanFinancialExtractor composes the
// real IFinancialExtractor (womblex money spans → summed AUD per matched
// requirement) behind the same port the Numbatch one satisfies. This proves the
// money-span path is wired *behind the port* — the controller, once built with it,
// puts real currency in the review grid, and the per-brand pivot totals it.
describe("container — money-span financial extractor wiring (item 1)", () => {
  class FakeMoneySpanStore implements IMoneySpanStore {
    constructor(private readonly rows: readonly MoneySpanRow[]) {}
    async fetchByDocument(
      evaluationId: string,
      documentId: string,
    ): Promise<Result<readonly MoneySpanRow[]>> {
      void evaluationId;
      return ok(this.rows.filter((row) => row.documentId === documentId));
    }
    async fetchByStructure(
      evaluationId: string,
      filter: MoneySpanFilter,
    ): Promise<Result<readonly MoneySpanRow[]>> {
      void evaluationId;
      return ok(
        this.rows.filter(
          (row) => filter.documentId === undefined || row.documentId === filter.documentId,
        ),
      );
    }
  }

  const money = (over: Partial<MoneySpanRow> = {}): MoneySpanRow => ({
    documentId: "doc-1",
    locus: "table_cell",
    parentElementOrder: 4,
    rowIndex: 1,
    columnIndex: 0,
    text: "1200",
    value: "1200.0000",
    currency: "AUD",
    ...over,
  });

  it("builds a real tender's priced rows into numeric AUD in the review grid and pivot", async () => {
    // The header-evidenced bare-number column (98.7% case): two priced rows whose
    // money-ness came from the `Amount (AUD)` header, so the cell text is a bare
    // number and the currency rides on the span.
    const store = new FakeMoneySpanStore([
      money({ rowIndex: 1, text: "1200", value: "1200.0000" }),
      money({ rowIndex: 2, text: "800", value: "800.0000" }),
    ]);
    const realExtractor = buildMoneySpanFinancialExtractor({ moneySpanStore: store });

    const repository = new InMemoryRepository();
    const evaluation = makeEvaluation({ id: "eval-1", name: "Tender", stage: "classifying" });
    if (isErr(evaluation)) throw new Error("bad seed");
    repository.seed(evaluation.data);
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

    const container = buildContainer({
      repository,
      classifier,
      financialExtractor: realExtractor,
      extractionReader,
      languageModel,
      stagedCorpusReader,
      lensWriter,
      productName: "Platform",
    });
    expect(isOk(container)).toBe(true);
    if (!isOk(container)) return;

    const controller = new WorkflowController(container.data);
    const built = await controller.buildTable({ evaluationId: "eval-1" });
    expect(isOk(built)).toBe(true);
    if (!isOk(built)) return;

    // The priced rows summed to a real number on the matched requirement.
    expect(built.data).toHaveLength(1);
    expect(built.data[0].costing.estimateAud).toBe(2000);

    // The review grid shows it numeric.
    const grid = await controller.openReviewGrid({ evaluationId: "eval-1" });
    if (!isOk(grid)) throw new Error("grid failed");
    const rows = grid.data.all();
    expect(rows[0].cells.estimateAud.isNumeric).toBe(true);
    expect(rows[0].cells.estimateAud.sortValue).toBe(2000);

    // The per-brand pivot totals the same figure.
    const pivot = await controller.openPricingPivot({ evaluationId: "eval-1" });
    if (!isOk(pivot)) throw new Error("pivot failed");
    const perBrand = pivot.data.compute({ axis: "brand", measure: "sum" });
    expect(perBrand.rows[0].key).toBe("Acme");
    expect(perBrand.grandTotal.value).toBe(2000);
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
