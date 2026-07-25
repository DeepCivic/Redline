import { describe, it, expect } from "vitest";
import type { ProcurementResponse } from "@redline/redline-domain";
import { PricingPivot } from "./pricing-pivot";
import { renderPivotView } from "./pricing-view";

// Thread 13 view model — the pure PricingPivotResult → table transform the
// Next.js/React shell binds to. Proves header/label shaping, currency
// formatting for display, blank cells for the no-figure case, and that the
// cross-tab lays out one column per secondary group. The Playwright e2e proves
// the DOM; this proves the model the DOM binds to (ADR-0006).

const response = (over: Partial<ProcurementResponse> = {}): ProcurementResponse => ({
  evaluationId: "eval-1",
  responseGroupId: "g-acme",
  vendorName: "Acme",
  productName: "Core Platform",
  requirementId: "req-data-residency",
  confidence: 0.86,
  productSummary: "A concise summary.",
  costing: { estimateAud: 1000, description: "" },
  source: { documentId: "doc-a", elementOrder: 1, page: null, chunkId: null },
  ...over,
});

const fixture: ProcurementResponse[] = [
  response({ vendorName: "Acme", requirementId: "req-data-residency", costing: { estimateAud: 1000, description: "" } }),
  response({ vendorName: "Acme", requirementId: "req-support", costing: { estimateAud: 500, description: "" } }),
  response({ vendorName: "Globex", requirementId: "req-data-residency", costing: { estimateAud: 2000, description: "" } }),
];

describe("renderPivotView", () => {
  it("renders a per-brand sum with a single measure column and formatted currency", () => {
    const result = new PricingPivot(fixture).compute({ axis: "brand", measure: "sum" });
    const view = renderPivotView({ axis: "brand", measure: "sum", result });

    expect(view.primaryHeader).toBe("Vendor");
    expect(view.measureHeader).toBe("Total (AUD)");
    expect(view.columnHeaders).toEqual([]);

    const acme = view.rows.find((row) => row.key === "Acme");
    expect(acme?.total.value).toBe(1500);
    expect(acme?.total.display).toContain("1,500");
    expect(view.grandTotal.display).toContain("3,500");
    expect(view.hasNumericData).toBe(true);
  });

  it("labels an average pivot and formats the mean", () => {
    const result = new PricingPivot(fixture).compute({ axis: "brand", measure: "avg" });
    const view = renderPivotView({ axis: "brand", measure: "avg", result });

    expect(view.measureHeader).toBe("Average (AUD)");
    const acme = view.rows.find((row) => row.key === "Acme");
    expect(acme?.total.value).toBe(750);
  });

  it("lays out one column per secondary group for a brand × requirement cross-tab", () => {
    const result = new PricingPivot(fixture).compute({ axis: "brand-x-requirement", measure: "sum" });
    const view = renderPivotView({ axis: "brand-x-requirement", measure: "sum", result });

    expect(view.columnHeaders.length).toBe(result.secondaryGroups?.length);
    const acme = view.rows.find((row) => row.key === "Acme");
    expect(acme?.cells.length).toBe(view.columnHeaders.length);
  });

  it("renders an empty cell (not $0.00) where a group has no numeric figure", () => {
    const result = new PricingPivot([
      response({ costing: { estimateAud: null, description: "on request" } }),
    ]).compute({ axis: "brand", measure: "sum" });
    const view = renderPivotView({ axis: "brand", measure: "sum", result });

    expect(view.hasNumericData).toBe(false);
    expect(view.rows[0].total.display).toBe("");
    expect(view.grandTotal.display).toBe("");
  });
});
