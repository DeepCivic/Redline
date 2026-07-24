import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err, domainError } from "@redline/redline-domain";
import type {
  ExtractionChunk,
  FinancialExtraction,
  IFinancialExtractor,
  ILanguageModel,
  IProcurementClassifier,
  IProcurementExtractionReader,
  RequirementClassification,
  SummaryRequest,
} from "@redline/redline-domain";
import { InMemoryEvaluationRepository } from "./in-memory-evaluation-repository.test-support";
import { BuildEvaluationTable } from "./build-evaluation-table";

// ── In-memory port fakes (never mock what we own) ────────────────────────────

const classifierReturning = (
  rows: readonly RequirementClassification[],
): IProcurementClassifier => ({
  async classifyResponseGroup() {
    return ok(rows);
  },
});

const extractorReturning = (
  rows: readonly FinancialExtraction[],
): IFinancialExtractor => ({
  async extractFinancials() {
    return ok(rows);
  },
});

// A reader that serves chunks (for summary passages) and one element per doc
// (for source provenance) so the joined response has real provenance.
const readerWith = (chunksByDocument: Record<string, ExtractionChunk[]>): IProcurementExtractionReader => ({
  async readElements(_evaluationId: string, documentId: string) {
    return ok([{ documentId, elementOrder: 3, page: 2, text: "element" }]);
  },
  async readChunks(_evaluationId: string, documentId: string) {
    return ok(chunksByDocument[documentId] ?? []);
  },
  async readTableCells() {
    return ok([]);
  },
});

const echoModel: ILanguageModel = {
  async summarise(request: SummaryRequest) {
    return ok(`${request.productName} by ${request.vendorName}: ${request.passages.length} passages`);
  },
};

// ── Seed: an evaluation at `classifying` with one vendor + one group ─────────

const seededRepository = async () => {
  const repository = new InMemoryEvaluationRepository();
  await repository.saveEvaluation({ id: "eval-1", name: "Cloud RFP", stage: "classifying" });
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
    label: "Acme — Core Platform",
    documentIds: ["doc-a"],
    isConsortiumResponse: false,
  });
  return repository;
};

const dependencies = (repository: InMemoryEvaluationRepository) => ({
  repository,
  classifier: classifierReturning([
    {
      documentId: "doc-a",
      requirementId: "req-data-residency",
      confidence: 0.86,
      sourceChunkId: "doc-a:2",
    },
  ]),
  financialExtractor: extractorReturning([
    {
      documentId: "doc-a",
      requirementId: "req-data-residency",
      elementOrder: 7,
      estimateAud: 1500.5,
      description: "annual licence",
    },
  ]),
  extractionReader: readerWith({
    "doc-a": [
      { chunkId: "doc-a:2", documentId: "doc-a", text: "data stays in AU" },
      { chunkId: "doc-a:3", documentId: "doc-a", text: "region ap-southeast-2" },
    ],
  }),
  languageModel: echoModel,
  productName: "Acme Platform",
});

describe("BuildEvaluationTable — the exit test", () => {
  it("joins classification + financials + summary into a full ProcurementResponse[]", async () => {
    const repository = await seededRepository();
    const useCase = new BuildEvaluationTable(dependencies(repository));

    const result = await useCase.execute({ evaluationId: "eval-1" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.data).toHaveLength(1);
    const [response] = result.data;
    expect(response.evaluationId).toBe("eval-1");
    expect(response.responseGroupId).toBe("g-acme");
    expect(response.vendorName).toBe("Acme");
    expect(response.productName).toBe("Acme Platform");
    expect(response.requirementId).toBe("req-data-residency");
    expect(response.confidence).toBeCloseTo(0.86);
    // Costing carried the real currency figure from the financial extractor.
    expect(response.costing.estimateAud).toBe(1500.5);
    // Provenance points at the financial extraction's element order.
    expect(response.source.elementOrder).toBe(7);
    expect(response.source.chunkId).toBe("doc-a:2");
    // The summary condensed the matched passages.
    expect(response.productSummary).toContain("2 passages");

    // The responses were persisted and the stage advanced to review.
    expect(repository.responses.get("eval-1")).toHaveLength(1);
    expect(repository.evaluations.get("eval-1")?.stage).toBe("review");
  });

  it("falls back to a description costing when no figure was extracted", async () => {
    const repository = await seededRepository();
    const deps = {
      ...dependencies(repository),
      financialExtractor: extractorReturning([
        {
          documentId: "doc-a",
          requirementId: "req-data-residency",
          elementOrder: 0,
          estimateAud: null,
          description: "priced on application",
        },
      ]),
    };
    const useCase = new BuildEvaluationTable(deps);

    const result = await useCase.execute({ evaluationId: "eval-1" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0].costing.estimateAud).toBeNull();
    expect(result.data[0].costing.description).toBe("priced on application");
  });

  it("uses an empty-costing fallback when the extractor returned no row for a match", async () => {
    const repository = await seededRepository();
    const deps = { ...dependencies(repository), financialExtractor: extractorReturning([]) };
    const useCase = new BuildEvaluationTable(deps);

    const result = await useCase.execute({ evaluationId: "eval-1" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // No figure and no extractor description ⇒ the "no costing yet" fallback.
    expect(result.data[0].costing.estimateAud).toBeNull();
    expect(result.data[0].costing.description).not.toBe("");
  });

  it("propagates a classifier failure without persisting anything", async () => {
    const repository = await seededRepository();
    const deps = {
      ...dependencies(repository),
      classifier: {
        async classifyResponseGroup() {
          return err(domainError("CLASSIFICATION_FAILED", "numbatch down"));
        },
      } satisfies IProcurementClassifier,
    };
    const useCase = new BuildEvaluationTable(deps);

    const result = await useCase.execute({ evaluationId: "eval-1" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
    expect(repository.responses.get("eval-1")).toBeUndefined();
    expect(repository.evaluations.get("eval-1")?.stage).toBe("classifying");
  });

  it("fails when the evaluation is not at the classifying stage", async () => {
    const repository = new InMemoryEvaluationRepository();
    await repository.saveEvaluation({ id: "eval-1", name: "Cloud RFP", stage: "grouping" });
    const useCase = new BuildEvaluationTable(dependencies(repository));

    const result = await useCase.execute({ evaluationId: "eval-1" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
