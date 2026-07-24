import { describe, it, expect } from "vitest";
import {
  evaluationToRow,
  rowToEvaluation,
  vendorToRow,
  rowToVendor,
  responseGroupToRow,
  rowToResponseGroup,
  responseToRow,
  rowToResponse,
} from "./row-mapping";
import type {
  EvaluationRow,
  VendorRow,
  ResponseGroupRow,
  ResponseRow,
} from "./schema";

// Pure domain ↔ row mapping — no DB. The load-bearing cases are the currency
// numeric ↔ decimal-string round-trip and the nullable provenance fields.

const now = new Date("2026-07-30T00:00:00Z");

describe("row-mapping — evaluation", () => {
  it("maps a domain evaluation to an insert row", () => {
    const row = evaluationToRow({ id: "eval-1", name: "Cloud RFT", stage: "grouping" });
    expect(row).toMatchObject({ id: "eval-1", name: "Cloud RFT", stage: "grouping" });
  });

  it("reads a row back into a domain evaluation, dropping timestamps", () => {
    const row: EvaluationRow = {
      id: "eval-1",
      name: "Cloud RFT",
      stage: "review",
      createdAt: now,
      updatedAt: now,
    };
    expect(rowToEvaluation(row)).toEqual({ id: "eval-1", name: "Cloud RFT", stage: "review" });
  });
});

describe("row-mapping — vendor", () => {
  it("round-trips a consortium's member ids", () => {
    const vendor = {
      id: "v1",
      displayName: "Acme + Beta",
      isConsortium: true,
      memberVendorIds: ["v-acme", "v-beta"],
    };
    const row = vendorToRow("eval-1", vendor);
    expect(row.evaluationId).toBe("eval-1");
    const back = rowToVendor({ ...row, createdAt: now, updatedAt: now } as VendorRow);
    expect(back).toEqual(vendor);
  });
});

describe("row-mapping — response group", () => {
  it("round-trips vendor and document id arrays", () => {
    const group = {
      id: "g1",
      evaluationId: "eval-1",
      vendorIds: ["v1", "v2"],
      label: "Acme — Core Bid",
      documentIds: ["82f9355e", "5c1a7be0"],
      isConsortiumResponse: true,
    };
    const back = rowToResponseGroup({
      ...responseGroupToRow(group),
      createdAt: now,
      updatedAt: now,
    } as ResponseGroupRow);
    expect(back).toEqual(group);
  });
});

describe("row-mapping — procurement response", () => {
  const response = {
    evaluationId: "eval-1",
    responseGroupId: "g1",
    vendorName: "Acme",
    productName: "Acme Cloud",
    requirementId: "req-data-residency",
    confidence: 0.86,
    productSummary: "Sovereign hosting with onshore support.",
    costing: { estimateAud: 1500.5, description: "Annual" },
    source: { documentId: "82f9355e", elementOrder: 7, page: 3, chunkId: "82f9355e:4" },
  };

  it("stores estimateAud as a decimal string and reads it back as a number", () => {
    const row = responseToRow("resp-1", response);
    // Numeric columns are decimal strings on the wire; the review grid needs a
    // real number, so the read side coerces back.
    expect(row.estimateAud).toBe("1500.50");
    const back = rowToResponse({ ...row, createdAt: now, updatedAt: now } as ResponseRow);
    expect(back.costing.estimateAud).toBe(1500.5);
    expect(back).toMatchObject(response);
  });

  it("maps a null estimate (description fallback) both ways", () => {
    const fallback = {
      ...response,
      costing: { estimateAud: null, description: "Priced on application" },
    };
    const row = responseToRow("resp-2", fallback);
    expect(row.estimateAud).toBeNull();
    const back = rowToResponse({ ...row, createdAt: now, updatedAt: now } as ResponseRow);
    expect(back.costing.estimateAud).toBeNull();
    expect(back.costing.description).toBe("Priced on application");
  });

  it("preserves nullable source provenance", () => {
    const noProvenance = {
      ...response,
      source: { documentId: "82f9355e", elementOrder: 0, page: null, chunkId: null },
    };
    const row = responseToRow("resp-3", noProvenance);
    expect(row.sourcePage).toBeNull();
    expect(row.sourceChunkId).toBeNull();
    const back = rowToResponse({ ...row, createdAt: now, updatedAt: now } as ResponseRow);
    expect(back.source).toEqual(noProvenance.source);
  });
});
