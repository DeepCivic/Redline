import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err, domainError, makeEvaluation, makeHardRuleSet } from "@redline/redline-domain";
import type {
  Adjudication,
  AdjudicationRequest,
  ChunkRow,
  Evaluation,
  IAdjudicator,
  IChunkStore,
  IEvaluationRepository,
  IFinancialExtractor,
  ILanguageModel,
  IProcurementClassifier,
  IProcurementExtractionReader,
  ProcurementResponse,
  Result,
  ResponseGroup,
  ScoredChunkRef,
  StructureFilter,
  Topic,
  Vendor,
} from "@redline/redline-domain";
import { WorkflowController, buildColdStartClassifier, buildContainer } from "./container";

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
      topics,
      ruleSet: ruleSet.data,
      candidates: [],
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
      topics,
      ruleSet: ruleSet.data,
      candidates: [{ documentId: "SEC-014", subjects: ["SEC-014"] }],
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
