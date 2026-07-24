import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err, domainError, makeEvaluation } from "@redline/redline-domain";
import type {
  Evaluation,
  IEvaluationRepository,
  IFinancialExtractor,
  ILanguageModel,
  IProcurementClassifier,
  IProcurementExtractionReader,
  ProcurementResponse,
  ResponseGroup,
  Vendor,
} from "@redline/redline-domain";
import { WorkflowController } from "./container";

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
