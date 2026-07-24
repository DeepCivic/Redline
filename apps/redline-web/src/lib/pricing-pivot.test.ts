import { describe, it, expect } from "vitest";
import { computePivot, type PivotColumn, type FieldReportSessionRow } from "@rbrasier/domain";
import type { ProcurementResponse } from "@redline/redline-domain";
import { PricingPivot, PIVOT_AXES } from "./pricing-pivot";

// Thread 13 exit test — pricing pivots (build plan §1 "Aggregate: pricing per
// brand (vendor); pricing per requirement/criterion", §7 Track 4). The pivot
// rolls the Thread 10/12 ProcurementResponse[] up per brand, per requirement,
// and brand×requirement, summing/averaging the real-number estimateAud (Thread
// 8/10). The exit criterion is "pivot matches hand-computed totals on a
// fixture" — proven below, and cross-checked against Wayfinder's own
// `computePivot` (the read-only reuse §9 / ADR-0006 calls for; the assertion is
// test-only, so the app keeps its allowed production dependency set exactly as
// Thread 12 did with `typedDisplayCell`).

const response = (over: Partial<ProcurementResponse> = {}): ProcurementResponse => ({
  evaluationId: "eval-1",
  responseGroupId: "g-acme",
  vendorName: "Acme",
  productName: "Core Platform",
  requirementId: "req-data-residency",
  confidence: 0.86,
  productSummary: "A concise one-paragraph summary.",
  costing: { estimateAud: 1000, description: "" },
  source: { documentId: "doc-a", elementOrder: 7, page: 3, chunkId: "doc-a:2" },
  ...over,
});

// The fixture: three vendors across two requirements, with a null-estimate
// (description fallback) row that must be excluded from the numeric roll-up.
//                        vendor    requirement          estimateAud
//   Acme    · residency  1000
//   Acme    · support     500
//   Globex  · residency  2000
//   Globex  · support    null   (description fallback — excluded)
//   Initech · residency  3000
const fixture: ProcurementResponse[] = [
  response({ responseGroupId: "g-acme", vendorName: "Acme", requirementId: "req-data-residency", costing: { estimateAud: 1000, description: "" }, source: { documentId: "doc-a", elementOrder: 1, page: null, chunkId: null } }),
  response({ responseGroupId: "g-acme", vendorName: "Acme", requirementId: "req-support", costing: { estimateAud: 500, description: "" }, source: { documentId: "doc-a", elementOrder: 2, page: null, chunkId: null } }),
  response({ responseGroupId: "g-globex", vendorName: "Globex", requirementId: "req-data-residency", costing: { estimateAud: 2000, description: "" }, source: { documentId: "doc-b", elementOrder: 1, page: null, chunkId: null } }),
  response({ responseGroupId: "g-globex", vendorName: "Globex", requirementId: "req-support", costing: { estimateAud: null, description: "quoted on request" }, source: { documentId: "doc-b", elementOrder: 2, page: null, chunkId: null } }),
  response({ responseGroupId: "g-initech", vendorName: "Initech", requirementId: "req-data-residency", costing: { estimateAud: 3000, description: "" }, source: { documentId: "doc-c", elementOrder: 1, page: null, chunkId: null } }),
];

describe("PricingPivot", () => {
  it("exposes the three axes the plan calls for", () => {
    expect(PIVOT_AXES).toEqual(["brand", "requirement", "brand-x-requirement"]);
  });

  it("sums estimateAud per brand (vendor), ranked by descending total", () => {
    const pivot = new PricingPivot(fixture);
    const result = pivot.compute({ axis: "brand", measure: "sum" });

    // Hand-computed: Initech 3000, Globex 2000, Acme 1500 → ranked desc.
    expect(result.rows.map((row) => ({ key: row.key, total: row.total.value }))).toEqual([
      { key: "Initech", total: 3000 },
      { key: "Globex", total: 2000 },
      { key: "Acme", total: 1500 },
    ]);
    expect(result.grandTotal.value).toBe(6500);
    // The null-estimate row contributed no numeric sample.
    expect(result.grandTotal.sampleCount).toBe(4);
  });

  it("averages estimateAud per brand, dividing only by numeric samples", () => {
    const pivot = new PricingPivot(fixture);
    const result = pivot.compute({ axis: "brand", measure: "avg" });

    const byKey = new Map(result.rows.map((row) => [row.key, row.total]));
    // Acme: (1000 + 500) / 2 = 750; Globex: 2000 / 1 (null excluded); Initech: 3000.
    expect(byKey.get("Acme")).toEqual({ value: 750, sampleCount: 2 });
    expect(byKey.get("Globex")).toEqual({ value: 2000, sampleCount: 1 });
    expect(byKey.get("Initech")).toEqual({ value: 3000, sampleCount: 1 });
  });

  it("sums estimateAud per requirement/criterion", () => {
    const pivot = new PricingPivot(fixture);
    const result = pivot.compute({ axis: "requirement", measure: "sum" });

    // residency: 1000 + 2000 + 3000 = 6000; support: 500 (+ null excluded).
    expect(result.rows.map((row) => ({ key: row.key, total: row.total.value }))).toEqual([
      { key: "req-data-residency", total: 6000 },
      { key: "req-support", total: 500 },
    ]);
  });

  it("cross-tabulates brand × requirement", () => {
    const pivot = new PricingPivot(fixture);
    const result = pivot.compute({ axis: "brand-x-requirement", measure: "sum" });

    expect(result.secondaryGroups).not.toBeNull();
    // Primary axis is brand (ranked by total), secondary is requirement.
    expect(result.primaryGroups).toEqual(["Initech", "Globex", "Acme"]);

    // Acme's cells across the requirement columns, in secondary-group order.
    const acmeRow = result.rows.find((row) => row.key === "Acme");
    const columnFor = (requirementId: string) =>
      acmeRow!.cells[result.secondaryGroups!.indexOf(requirementId)].value;
    expect(columnFor("req-data-residency")).toBe(1000);
    expect(columnFor("req-support")).toBe(500);
  });

  it("reports no numeric data when every row is a description fallback", () => {
    const pivot = new PricingPivot([
      response({ costing: { estimateAud: null, description: "on request" } }),
    ]);
    const result = pivot.compute({ axis: "brand", measure: "sum" });
    expect(result.hasNumericData).toBe(false);
    expect(result.grandTotal).toEqual({ value: 0, sampleCount: 0 });
  });

  it("matches Wayfinder's computePivot on the same data (read-only reuse, test-only)", () => {
    // The reuse the plan §9 names: our pivot must agree with Wayfinder's engine
    // when the ProcurementResponse[] is projected onto its FieldReportSessionRow
    // shape. This pins the contract on both sides without importing Wayfinder
    // into production app code.
    const columns: PivotColumn[] = [
      { columnKey: "vendorName", label: "Vendor", type: "text", memberKeys: ["vendorName"] },
      { columnKey: "estimateAud", label: "Estimate (AUD)", type: "currency", memberKeys: ["estimateAud"] },
    ];
    const wayfinderRows: FieldReportSessionRow[] = fixture.map((response, index) => ({
      sessionId: `row-${index}`,
      startedAt: new Date(0),
      status: "complete",
      values: {
        vendorName: response.vendorName,
        estimateAud: response.costing.estimateAud === null ? "" : String(response.costing.estimateAud),
      },
    }));
    const expected = computePivot(wayfinderRows, {
      columns,
      groupByKey: "vendorName",
      measure: { kind: "sum", columnKey: "estimateAud" },
    });

    const ours = new PricingPivot(fixture).compute({ axis: "brand", measure: "sum" });
    expect(ours.rows.map((row) => ({ key: row.key, value: row.total.value }))).toEqual(
      expected.rows.map((row) => ({ key: row.key, value: row.total.value })),
    );
    expect(ours.grandTotal.value).toBe(expected.grandTotal.value);
  });
});
