import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err, domainError } from "@redline/redline-domain";
import type {
  ClassificationRequest,
  FinancialExtractionRequest,
  IFinancialExtractor,
  IProcurementClassifier,
} from "@redline/redline-domain";
import { ClassifyResponseGroup } from "./classify-response-group";
import { ExtractFinancials } from "./extract-financials";

const group = {
  evaluationId: "eval-1",
  responseGroupId: "g-acme",
  documentIds: ["doc-a", "doc-b"],
} as const;

describe("ClassifyResponseGroup", () => {
  it("passes the group through to the classifier and returns its rows", async () => {
    let seen: ClassificationRequest | null = null;
    const classifier: IProcurementClassifier = {
      async classifyResponseGroup(request) {
        seen = request;
        return ok([
          { documentId: "doc-a", requirementId: "req-1", confidence: 0.9, sourceChunkId: null },
        ]);
      },
    };
    const useCase = new ClassifyResponseGroup({ classifier });

    const result = await useCase.execute(group);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(seen).toEqual(group);
  });

  it("surfaces a classifier failure as-is", async () => {
    const classifier: IProcurementClassifier = {
      async classifyResponseGroup() {
        return err(domainError("CLASSIFICATION_FAILED", "down"));
      },
    };
    const useCase = new ClassifyResponseGroup({ classifier });

    const result = await useCase.execute(group);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });
});

describe("ExtractFinancials", () => {
  it("passes the request through to the financial extractor", async () => {
    let seen: FinancialExtractionRequest | null = null;
    const financialExtractor: IFinancialExtractor = {
      async extractFinancials(request) {
        seen = request;
        return ok([
          {
            documentId: "doc-a",
            requirementId: "req-1",
            elementOrder: 4,
            estimateAud: 100,
            description: "",
          },
        ]);
      },
    };
    const useCase = new ExtractFinancials({ financialExtractor });

    const result = await useCase.execute(group);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0].estimateAud).toBe(100);
    expect(seen).toEqual(group);
  });

  it("surfaces an extractor failure as-is", async () => {
    const financialExtractor: IFinancialExtractor = {
      async extractFinancials() {
        return err(domainError("INFRA_FAILURE", "no db"));
      },
    };
    const useCase = new ExtractFinancials({ financialExtractor });

    const result = await useCase.execute(group);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });
});
