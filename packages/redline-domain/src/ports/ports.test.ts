import { describe, it, expect } from "vitest";
import { isOk } from "../result";
import { ok, type Result } from "../result";
import { domainError } from "../errors/domain-error";
import { makeEvaluation, type Evaluation } from "../entities/evaluation";
import {
  makeResponseGroup,
  makeVendor,
  type ResponseGroup,
  type Vendor,
} from "../entities/evaluation-structure";
import {
  makeProcurementResponse,
  type ProcurementResponse,
} from "../entities/procurement-response";
import type { IEvaluationRepository } from "./evaluation-repository";
import type {
  IProcurementExtractionReader,
  ExtractionChunk,
  ExtractionElement,
  ExtractionTableCell,
} from "./procurement-extraction-reader";
import type {
  IProcurementClassifier,
  RequirementClassification,
} from "./procurement-classifier";
import type { FinancialExtraction, IFinancialExtractor } from "./financial-extractor";

// These fakes exist to prove the port interfaces are implementable and shaped as
// the downstream threads (4, 5, 7, 9) will need. They are the ports' spec.

class InMemoryEvaluationRepository implements IEvaluationRepository {
  private readonly evaluations = new Map<string, Evaluation>();
  private readonly vendors = new Map<string, Vendor[]>();
  private readonly groups = new Map<string, ResponseGroup[]>();
  private readonly responses = new Map<string, ProcurementResponse[]>();

  async saveEvaluation(evaluation: Evaluation): Promise<Result<Evaluation>> {
    this.evaluations.set(evaluation.id, evaluation);
    return ok(evaluation);
  }

  async findEvaluation(evaluationId: string): Promise<Result<Evaluation>> {
    const found = this.evaluations.get(evaluationId);
    if (!found) return { error: domainError("NOT_FOUND", "evaluation not found") };
    return ok(found);
  }

  async saveVendor(evaluationId: string, vendor: Vendor): Promise<Result<Vendor>> {
    const existing = this.vendors.get(evaluationId) ?? [];
    this.vendors.set(evaluationId, [...existing, vendor]);
    return ok(vendor);
  }

  async listVendors(evaluationId: string): Promise<Result<readonly Vendor[]>> {
    return ok(this.vendors.get(evaluationId) ?? []);
  }

  async saveResponseGroup(group: ResponseGroup): Promise<Result<ResponseGroup>> {
    const existing = this.groups.get(group.evaluationId) ?? [];
    this.groups.set(group.evaluationId, [...existing, group]);
    return ok(group);
  }

  async listResponseGroups(evaluationId: string): Promise<Result<readonly ResponseGroup[]>> {
    return ok(this.groups.get(evaluationId) ?? []);
  }

  async saveResponses(
    responses: readonly ProcurementResponse[],
  ): Promise<Result<readonly ProcurementResponse[]>> {
    for (const response of responses) {
      const existing = this.responses.get(response.evaluationId) ?? [];
      this.responses.set(response.evaluationId, [...existing, response]);
    }
    return ok(responses);
  }

  async listResponses(evaluationId: string): Promise<Result<readonly ProcurementResponse[]>> {
    return ok(this.responses.get(evaluationId) ?? []);
  }
}

class StubExtractionReader implements IProcurementExtractionReader {
  async readElements(): Promise<Result<readonly ExtractionElement[]>> {
    return ok([{ documentId: "hashA", elementOrder: 0, page: 1, text: "Acme response" }]);
  }
  async readChunks(): Promise<Result<readonly ExtractionChunk[]>> {
    return ok([{ chunkId: "hashA:0", documentId: "hashA", text: "chunk" }]);
  }
  async readTableCells(): Promise<Result<readonly ExtractionTableCell[]>> {
    return ok([
      {
        documentId: "hashA",
        elementOrder: 5,
        page: 2,
        rowIndex: 0,
        columnIndex: 1,
        rawValue: "80000",
        isCurrency: true,
      },
    ]);
  }
}

class StubClassifier implements IProcurementClassifier {
  async classifyResponseGroup(): Promise<Result<readonly RequirementClassification[]>> {
    return ok([
      {
        documentId: "hashA",
        requirementId: "req-1",
        confidence: 0.92,
        sourceChunkId: "hashA:0",
      },
    ]);
  }
}

class StubFinancialExtractor implements IFinancialExtractor {
  async extractFinancials(): Promise<Result<readonly FinancialExtraction[]>> {
    return ok([
      {
        documentId: "hashA",
        requirementId: "req-1",
        elementOrder: 5,
        estimateAud: 80000,
        description: "",
      },
    ]);
  }
}

describe("port conformance (in-memory fakes)", () => {
  it("round-trips the evaluation aggregate through the repository", async () => {
    const repository = new InMemoryEvaluationRepository();

    const evaluation = makeEvaluation({ id: "e1", name: "Panel" });
    const vendor = makeVendor({ id: "v1", displayName: "Acme" });
    const group = makeResponseGroup({
      id: "g1",
      evaluationId: "e1",
      vendorIds: ["v1"],
      label: "Acme bid",
      documentIds: ["hashA"],
    });
    const response = makeProcurementResponse({
      evaluationId: "e1",
      responseGroupId: "g1",
      vendorName: "Acme",
      productName: "Core Platform",
      requirementId: "req-1",
      confidence: 0.92,
      productSummary: "A platform.",
      costing: { estimateAud: 80000, description: "" },
      source: { documentId: "hashA", elementOrder: 5 },
    });

    expect(isOk(evaluation) && isOk(vendor) && isOk(group) && isOk(response)).toBe(true);
    if (!isOk(evaluation) || !isOk(vendor) || !isOk(group) || !isOk(response)) return;

    await repository.saveEvaluation(evaluation.data);
    await repository.saveVendor("e1", vendor.data);
    await repository.saveResponseGroup(group.data);
    await repository.saveResponses([response.data]);

    const found = await repository.findEvaluation("e1");
    const responses = await repository.listResponses("e1");
    expect(isOk(found)).toBe(true);
    expect(isOk(responses)).toBe(true);
    if (!isOk(responses)) return;
    expect(responses.data).toHaveLength(1);
    expect(responses.data[0]?.vendorName).toBe("Acme");
  });

  it("reports NOT_FOUND for a missing evaluation", async () => {
    const repository = new InMemoryEvaluationRepository();
    const found = await repository.findEvaluation("missing");
    expect(isOk(found)).toBe(false);
    if (isOk(found)) return;
    expect(found.error.code).toBe("NOT_FOUND");
  });

  it("drives extraction → classification → financials via the ports", async () => {
    const reader: IProcurementExtractionReader = new StubExtractionReader();
    const classifier: IProcurementClassifier = new StubClassifier();
    const extractor: IFinancialExtractor = new StubFinancialExtractor();

    const cells = await reader.readTableCells("e1", "hashA");
    const classifications = await classifier.classifyResponseGroup({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["hashA"],
    });
    const financials = await extractor.extractFinancials({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["hashA"],
    });

    expect(isOk(cells) && isOk(classifications) && isOk(financials)).toBe(true);
    if (!isOk(classifications) || !isOk(financials)) return;
    expect(classifications.data[0]?.requirementId).toBe("req-1");
    expect(financials.data[0]?.estimateAud).toBe(80000);
  });
});
