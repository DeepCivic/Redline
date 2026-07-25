import { describe, it, expect } from "vitest";
import type { ProcurementResponse } from "@redline/redline-domain";
import { ReviewGrid } from "./review-grid";
import { renderReviewGridView } from "./review-view";

// The review view is a pure ReviewGrid → view-model transform the Next.js/React
// layer binds to, so header state, body cells, and the source deep-link href are
// unit-testable without a browser. The Playwright e2e proves the DOM; this
// proves the model the DOM binds to (ADR-0006).

const response = (over: Partial<ProcurementResponse> = {}): ProcurementResponse => ({
  evaluationId: "eval-1",
  responseGroupId: "g-acme",
  vendorName: "Acme",
  productName: "Core Platform",
  requirementId: "req-data-residency",
  confidence: 0.86,
  productSummary: "A concise summary.",
  costing: { estimateAud: 1500.5, description: "" },
  source: { documentId: "doc-a", elementOrder: 7, page: 3, chunkId: "doc-a:2" },
  ...over,
});

describe("renderReviewGridView", () => {
  it("renders headers, typed body cells, and a source deep-link with element/page/chunk", () => {
    const grid = new ReviewGrid([response()]);
    const view = renderReviewGridView({ evaluationId: "eval-1", grid });

    expect(view.isEmpty).toBe(false);
    expect(view.rowCount).toBe(1);
    expect(view.headers.map((h) => h.label)).toContain("Estimate (AUD)");

    const row = view.rows[0];
    // Cells are in column order; currency stays numeric for right-align/export.
    const estimate = view.headers.findIndex((h) => h.key === "estimateAud");
    expect(row.cells[estimate].isNumeric).toBe(true);

    // The source deep-link resolves to the exact document location.
    expect(row.source.label).toBe("doc-a · p.3");
    expect(row.source.href).toBe(
      "/evaluations/eval-1/documents/doc-a?element=7&page=3&chunk=doc-a%3A2",
    );
  });

  it("omits page/chunk from the href when the provenance lacks them", () => {
    const grid = new ReviewGrid([
      response({ source: { documentId: "doc-b", elementOrder: 2, page: null, chunkId: null } }),
    ]);
    const view = renderReviewGridView({ evaluationId: "eval-1", grid });

    expect(view.rows[0].source.href).toBe("/evaluations/eval-1/documents/doc-b?element=2");
  });

  it("reflects the active sort direction and the next-click direction on the header", () => {
    const grid = new ReviewGrid([response()]);
    const view = renderReviewGridView({
      evaluationId: "eval-1",
      grid,
      sort: { key: "estimateAud", direction: "asc" },
    });

    const estimate = view.headers.find((h) => h.key === "estimateAud");
    expect(estimate?.activeDirection).toBe("asc");
    expect(estimate?.nextDirection).toBe("desc"); // a second click toggles

    const vendor = view.headers.find((h) => h.key === "vendorName");
    expect(vendor?.activeDirection).toBeNull();
    expect(vendor?.nextDirection).toBe("asc"); // first click sorts ascending

    const source = view.headers.find((h) => h.key === "source");
    expect(source?.sortable).toBe(false);
    expect(source?.nextDirection).toBeNull(); // not sortable
  });

  it("exposes requirement filter options and applies a requirement filter", () => {
    const grid = new ReviewGrid([
      response({ responseGroupId: "g-1", requirementId: "req-a" }),
      response({ responseGroupId: "g-2", requirementId: "req-b" }),
    ]);
    const view = renderReviewGridView({
      evaluationId: "eval-1",
      grid,
      filter: { requirementId: "req-b" },
    });

    expect(view.requirementFilterOptions).toEqual(["req-a", "req-b"]);
    expect(view.rowCount).toBe(1);
    const requirement = view.headers.findIndex((h) => h.key === "requirementId");
    expect(view.rows[0].cells[requirement].display).toBe("req-b");
  });

  it("reports an empty grid for an evaluation with no responses", () => {
    const view = renderReviewGridView({ evaluationId: "eval-1", grid: new ReviewGrid([]) });
    expect(view.isEmpty).toBe(true);
    expect(view.rowCount).toBe(0);
    expect(view.rows).toEqual([]);
  });
});
