import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import { makeProcurementResponse } from "./procurement-response";

const validInput = () => ({
  evaluationId: "e1",
  responseGroupId: "g1",
  vendorName: "  Acme  ",
  productName: "  Core Platform  ",
  requirementNumber: 1 as const,
  categorisation: {
    solutionScope: "whole_solution" as const,
    userDefinedCategory: "  platform  ",
  },
  productSummary: "  A cloud-native procurement platform.  ",
  costing: { estimateAud: 80000, description: "  Annual licence  " },
  source: {
    documentId: "hashA",
    elementOrder: 12,
    page: 3,
    chunkId: "hashA:4",
  },
});

describe("makeProcurementResponse", () => {
  it("builds a fully specified response, trimming free text", () => {
    const result = makeProcurementResponse(validInput());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.vendorName).toBe("Acme");
    expect(result.data.productName).toBe("Core Platform");
    expect(result.data.categorisation.userDefinedCategory).toBe("platform");
    expect(result.data.productSummary).toBe("A cloud-native procurement platform.");
    expect(result.data.costing.estimateAud).toBe(80000);
    expect(result.data.costing.description).toBe("Annual licence");
  });

  it("allows a null estimate when only a cost description is available", () => {
    const result = makeProcurementResponse({
      ...validInput(),
      costing: { estimateAud: null, description: "Priced on application" },
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.costing.estimateAud).toBeNull();
    expect(result.data.costing.description).toBe("Priced on application");
  });

  it("defaults optional source provenance fields to null", () => {
    const input = validInput();
    const result = makeProcurementResponse({
      ...input,
      source: { documentId: "hashA", elementOrder: 0 },
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.source.page).toBeNull();
    expect(result.data.source.chunkId).toBeNull();
  });

  it("fails when the requirement number is out of range", () => {
    const result = makeProcurementResponse({
      ...validInput(),
      requirementNumber: 8 as unknown as 1,
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the vendor name is blank", () => {
    const result = makeProcurementResponse({ ...validInput(), vendorName: "  " });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when neither an estimate nor a cost description is provided", () => {
    const result = makeProcurementResponse({
      ...validInput(),
      costing: { estimateAud: null, description: "   " },
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when a provided estimate is negative", () => {
    const result = makeProcurementResponse({
      ...validInput(),
      costing: { estimateAud: -1, description: "Invalid" },
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the element order is not a non-negative integer", () => {
    const result = makeProcurementResponse({
      ...validInput(),
      source: { documentId: "hashA", elementOrder: -3 },
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
