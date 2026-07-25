import { describe, it, expect } from "vitest";
import type { ProcurementResponse } from "@redline/redline-domain";
import { ReviewGrid } from "./review-grid";
import { PricingPivot } from "./pricing-pivot";
import {
  buildReviewSheetData,
  buildPivotSheetData,
  buildEvaluationWorkbook,
  evaluationExportFileName,
} from "./excel-export";

// Thread 14 exit test — Excel export (build plan §1 "in-app review first; Excel
// export second", §7 Track 4). Reuses Wayfinder's XLSX path (the `write-excel-
// file` cell shape from apps/web/src/components/admin/field-report-export.ts, §9)
// so currency stays a real numeric cell, and adds one sheet for the review table
// plus one per pivot. The exit criterion is "workbook opens with numeric
// currency + working document links" — proven here at the sheet-data layer (the
// pure mapping the browser writer serialises), with the Playwright e2e opening a
// real download. The `write-excel-file` cell type is verified against Wayfinder's
// own verified usage, not training data (CLAUDE.md).

const response = (over: Partial<ProcurementResponse> = {}): ProcurementResponse => ({
  evaluationId: "eval-1",
  responseGroupId: "g-acme",
  vendorName: "Acme",
  productName: "Core Platform",
  requirementId: "req-data-residency",
  confidence: 0.86,
  productSummary: "A concise one-paragraph summary.",
  costing: { estimateAud: 1500.5, description: "Sovereign hosting — annual" },
  source: { documentId: "doc-a", elementOrder: 7, page: 3, chunkId: "doc-a:2" },
  ...over,
});

const fixture: ProcurementResponse[] = [
  response({ vendorName: "Acme", requirementId: "req-data-residency", costing: { estimateAud: 1000, description: "" }, source: { documentId: "doc-a", elementOrder: 1, page: 3, chunkId: "doc-a:2" } }),
  response({ vendorName: "Acme", requirementId: "req-support", costing: { estimateAud: 500, description: "" }, source: { documentId: "doc-a", elementOrder: 2, page: null, chunkId: null } }),
  response({ vendorName: "Globex", requirementId: "req-data-residency", costing: { estimateAud: 2000, description: "" }, source: { documentId: "doc-b", elementOrder: 1, page: null, chunkId: null } }),
  response({ vendorName: "Globex", requirementId: "req-support", costing: { estimateAud: null, description: "quoted on request" }, source: { documentId: "doc-b", elementOrder: 2, page: null, chunkId: null } }),
];

describe("buildReviewSheetData", () => {
  it("writes a bold header row of every review column, in display order", () => {
    const grid = new ReviewGrid(fixture);
    const data = buildReviewSheetData(grid, "eval-1");

    expect(data[0]).toEqual([
      { value: "Vendor", type: String, fontWeight: "bold" },
      { value: "Product", type: String, fontWeight: "bold" },
      { value: "Requirement", type: String, fontWeight: "bold" },
      { value: "Confidence", type: String, fontWeight: "bold" },
      { value: "Summary", type: String, fontWeight: "bold" },
      { value: "Estimate (AUD)", type: String, fontWeight: "bold" },
      { value: "Costing", type: String, fontWeight: "bold" },
      { value: "Source", type: String, fontWeight: "bold" },
    ]);
  });

  it("writes the currency estimate as a real Number cell (the exit criterion)", () => {
    const grid = new ReviewGrid(fixture);
    const data = buildReviewSheetData(grid, "eval-1");

    // The Acme × residency row: estimate 1000 must be a numeric cell, not text.
    const firstBody = data[1]!;
    const estimateCell = firstBody[5];
    expect(estimateCell).toEqual({ value: 1000, type: Number });

    // The matching Wayfinder cell — typedDisplayCell("currency", "1000") →
    // { value: 1000, isNumeric: true } — is asserted against the real helper in
    // redline-adapters' wayfinder-contract.test.ts (ADR-0012), so this suite
    // runs with no vendored Wayfinder present.
  });

  it("writes a blank cell (null) for a null estimate — never a misleading 0", () => {
    const grid = new ReviewGrid(fixture);
    const data = buildReviewSheetData(grid, "eval-1");

    // The Globex × support row carries a null estimate (description fallback).
    const nullEstimateRow = data.find((row) => row[0]?.value === "Globex" && row[2]?.value === "req-support");
    expect(nullEstimateRow![5]).toBeNull();
    // Its costing description still writes as text.
    expect(nullEstimateRow![6]).toEqual({ value: "quoted on request", type: String });
  });

  it("writes the source column as a working document deep-link hyperlink", () => {
    const grid = new ReviewGrid(fixture);
    const data = buildReviewSheetData(grid, "eval-1");

    const firstBody = data[1]!;
    const sourceCell = firstBody[7]!;
    // A hyperlink cell: display label + a resolvable href to the exact location.
    expect(sourceCell).toMatchObject({
      type: String,
      hyperlink: "/evaluations/eval-1/documents/doc-a?element=1&page=3&chunk=doc-a%3A2",
    });
    expect(sourceCell!.value).toContain("doc-a");
  });

  it("writes confidence as a numeric cell", () => {
    const grid = new ReviewGrid(fixture);
    const data = buildReviewSheetData(grid, "eval-1");
    expect(data[1]![3]).toEqual({ value: 0.86, type: Number });
  });
});

describe("buildPivotSheetData", () => {
  it("writes a per-brand sum pivot: a header, one numeric row per group, a grand total", () => {
    const result = new PricingPivot(fixture).compute({ axis: "brand", measure: "sum" });
    const data = buildPivotSheetData({ axis: "brand", measure: "sum", result });

    expect(data[0]).toEqual([
      { value: "Vendor", type: String, fontWeight: "bold" },
      { value: "Total (AUD)", type: String, fontWeight: "bold" },
    ]);

    // Globex 2000 ranks above Acme 1500.
    const globex = data.find((row) => row[0]?.value === "Globex");
    expect(globex![1]).toEqual({ value: 2000, type: Number });
    const acme = data.find((row) => row[0]?.value === "Acme");
    expect(acme![1]).toEqual({ value: 1500, type: Number });

    // A bold grand-total footer with the numeric grand total.
    const total = data[data.length - 1]!;
    expect(total[0]).toEqual({ value: "Total", type: String, fontWeight: "bold" });
    expect(total[1]).toEqual({ value: 3500, type: Number });
  });

  it("lays out one numeric column per secondary group for a brand × requirement cross-tab", () => {
    const result = new PricingPivot(fixture).compute({ axis: "brand-x-requirement", measure: "sum" });
    const data = buildPivotSheetData({ axis: "brand-x-requirement", measure: "sum", result });

    // Header: Vendor, one column per requirement, then a Total column.
    const header = data[0]!;
    expect(header[0]).toEqual({ value: "Vendor", type: String, fontWeight: "bold" });
    expect(header[header.length - 1]).toEqual({ value: "Total (AUD)", type: String, fontWeight: "bold" });
    expect(header.length).toBe(result.secondaryGroups!.length + 2);

    // Acme's residency cell = 1000, support cell = 500 in secondary-group order.
    const acme = data.find((row) => row[0]?.value === "Acme")!;
    const residencyColumn = result.secondaryGroups!.indexOf("req-data-residency") + 1;
    const supportColumn = result.secondaryGroups!.indexOf("req-support") + 1;
    expect(acme[residencyColumn]).toEqual({ value: 1000, type: Number });
    expect(acme[supportColumn]).toEqual({ value: 500, type: Number });
  });

  it("writes a blank cell (not 0) where a cross-tab intersection has no figure", () => {
    const result = new PricingPivot(fixture).compute({ axis: "brand-x-requirement", measure: "sum" });
    const data = buildPivotSheetData({ axis: "brand-x-requirement", measure: "sum", result });

    // Globex × support is the null-estimate row — no numeric sample.
    const globex = data.find((row) => row[0]?.value === "Globex")!;
    const supportColumn = result.secondaryGroups!.indexOf("req-support") + 1;
    expect(globex[supportColumn]).toBeNull();
  });
});

describe("buildEvaluationWorkbook", () => {
  it("produces one review sheet plus one sheet per pivot, with names", () => {
    const grid = new ReviewGrid(fixture);
    const pivot = new PricingPivot(fixture);
    const workbook = buildEvaluationWorkbook({ evaluationId: "eval-1", grid, pivot });

    expect(workbook.sheetNames).toEqual([
      "Review",
      "Pricing by Vendor",
      "Pricing by Requirement",
      "Vendor × Requirement",
    ]);
    // One data grid per named sheet.
    expect(workbook.sheets).toHaveLength(workbook.sheetNames.length);

    // The review sheet is the first; its header names the columns.
    expect(workbook.sheets[0][0][0]).toEqual({ value: "Vendor", type: String, fontWeight: "bold" });
    // The by-vendor pivot sheet carries the numeric grand total.
    const byVendor = workbook.sheets[1];
    expect(byVendor[byVendor.length - 1][1]).toEqual({ value: 3500, type: Number });
  });
});

describe("evaluationExportFileName", () => {
  it("slugs the evaluation name with the export date", () => {
    expect(evaluationExportFileName("Cloud Tender 2026", new Date("2026-08-04T09:00:00Z"))).toBe(
      "Cloud-Tender-2026-evaluation-2026-08-04.xlsx",
    );
  });

  it("collapses unsafe characters and falls back to a default stem", () => {
    expect(evaluationExportFileName("HR / On-boarding!", new Date("2026-01-02T00:00:00Z"))).toBe(
      "HR-On-boarding-evaluation-2026-01-02.xlsx",
    );
    expect(evaluationExportFileName("   ", new Date("2026-01-02T00:00:00Z"))).toBe(
      "evaluation-evaluation-2026-01-02.xlsx",
    );
  });
});
