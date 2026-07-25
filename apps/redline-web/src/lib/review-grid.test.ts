import { describe, it, expect } from "vitest";
import { typedDisplayCell } from "@rbrasier/domain";
import type { ProcurementResponse } from "@redline/redline-domain";
import { ReviewGrid, REVIEW_COLUMNS } from "./review-grid";

// Thread 12 exit test (the model the DOM binds to): a real evaluation's
// ProcurementResponse[] renders as typed grid rows, currency sorts numerically
// (not lexically), and each row carries the source provenance the deep-link
// resolves against. The Playwright e2e proves the DOM wiring; this proves the
// grid the shell binds to (same posture as view.test.ts / ADR-0006).

const response = (over: Partial<ProcurementResponse> = {}): ProcurementResponse => ({
  evaluationId: "eval-1",
  responseGroupId: "g-acme",
  vendorName: "Acme",
  productName: "Core Platform",
  requirementId: "req-data-residency",
  confidence: 0.86,
  productSummary: "A concise one-paragraph summary.",
  costing: { estimateAud: 1500.5, description: "" },
  source: { documentId: "doc-a", elementOrder: 7, page: 3, chunkId: "doc-a:2" },
  ...over,
});

describe("ReviewGrid", () => {
  it("turns each ProcurementResponse into one typed row keyed by (group, document, requirement)", () => {
    const grid = new ReviewGrid([response()]);
    const rows = grid.all();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("g-acme::doc-a::req-data-residency");
    expect(rows[0].cells.vendorName.display).toBe("Acme");
    expect(rows[0].cells.confidence.display).toBe("0.86");
    expect(rows[0].source).toEqual({
      documentId: "doc-a",
      elementOrder: 7,
      page: 3,
      chunkId: "doc-a:2",
      label: "doc-a · p.3",
    });
  });

  it("marks the currency cell numeric via typedDisplayCell and keeps a real number sort key", () => {
    const grid = new ReviewGrid([response({ costing: { estimateAud: 1500.5, description: "" } })]);
    const cell = grid.all()[0].cells.estimateAud;

    // The exit criterion — currency is numeric, consistent with the reused
    // Wayfinder helper the export path (Thread 14) needs.
    expect(typedDisplayCell("currency", "1500.5")).toEqual({ value: 1500.5, isNumeric: true });
    expect(cell.isNumeric).toBe(true);
    expect(cell.sortValue).toBe(1500.5);
    expect(cell.display).toContain("1,500.5");
  });

  it("sorts currency numerically, not lexically", () => {
    const grid = new ReviewGrid([
      response({ responseGroupId: "g-1", costing: { estimateAud: 100, description: "" } }),
      response({ responseGroupId: "g-2", costing: { estimateAud: 90, description: "" } }),
      response({ responseGroupId: "g-3", costing: { estimateAud: 1000, description: "" } }),
    ]);

    const asc = grid
      .view({ sort: { key: "estimateAud", direction: "asc" } })
      .map((row) => row.cells.estimateAud.sortValue);
    // Lexical order would put "1000" before "90"; numeric order does not.
    expect(asc).toEqual([90, 100, 1000]);

    const desc = grid
      .view({ sort: { key: "estimateAud", direction: "desc" } })
      .map((row) => row.cells.estimateAud.sortValue);
    expect(desc).toEqual([1000, 100, 90]);
  });

  it("sorts text columns case-insensitively and stably", () => {
    const grid = new ReviewGrid([
      response({ responseGroupId: "g-1", vendorName: "beta" }),
      response({ responseGroupId: "g-2", vendorName: "Alpha" }),
      response({ responseGroupId: "g-3", vendorName: "alpha" }),
    ]);

    const asc = grid
      .view({ sort: { key: "vendorName", direction: "asc" } })
      .map((row) => row.cells.vendorName.display);
    // Both "alpha"s precede "beta"; the two "alpha"s keep build order (stable).
    expect(asc).toEqual(["Alpha", "alpha", "beta"]);
  });

  it("clusters null-estimate (description fallback) rows and never marks them numeric", () => {
    const grid = new ReviewGrid([
      response({ responseGroupId: "g-1", costing: { estimateAud: 200, description: "" } }),
      response({
        responseGroupId: "g-2",
        costing: { estimateAud: null, description: "quoted on request" },
      }),
    ]);

    const fallbackCell = grid.all()[1].cells.estimateAud;
    expect(fallbackCell.isNumeric).toBe(false);
    expect(fallbackCell.display).toBe("");

    // Ascending: the null-estimate row sorts to the front (lowest), so the
    // "no figure" rows cluster rather than scatter.
    const asc = grid
      .view({ sort: { key: "estimateAud", direction: "asc" } })
      .map((row) => row.id);
    expect(asc[0]).toBe("g-2::doc-a::req-data-residency");
  });

  it("filters by free-text across every visible column, case-insensitively", () => {
    const grid = new ReviewGrid([
      response({ responseGroupId: "g-1", vendorName: "Acme" }),
      response({ responseGroupId: "g-2", vendorName: "Globex" }),
    ]);

    const matched = grid.view({ filter: { query: "glob" } });
    expect(matched).toHaveLength(1);
    expect(matched[0].cells.vendorName.display).toBe("Globex");
  });

  it("filters to a single requirement and exposes the distinct requirement ids", () => {
    const grid = new ReviewGrid([
      response({ responseGroupId: "g-1", requirementId: "req-a" }),
      response({ responseGroupId: "g-2", requirementId: "req-b" }),
      response({ responseGroupId: "g-3", requirementId: "req-a" }),
    ]);

    expect(grid.requirementIds()).toEqual(["req-a", "req-b"]);

    const onlyA = grid.view({ filter: { requirementId: "req-a" } });
    expect(onlyA).toHaveLength(2);
    expect(onlyA.every((row) => row.cells.requirementId.display === "req-a")).toBe(true);
  });

  it("does not sort by the unsortable source column", () => {
    const grid = new ReviewGrid([
      response({ responseGroupId: "g-1", source: { documentId: "doc-z", elementOrder: 1, page: null, chunkId: null } }),
      response({ responseGroupId: "g-2", source: { documentId: "doc-a", elementOrder: 1, page: null, chunkId: null } }),
    ]);

    const source = REVIEW_COLUMNS.find((column) => column.key === "source");
    expect(source?.sortable).toBe(false);

    // Requesting a sort on it is a no-op — rows stay in build order.
    const rows = grid.view({ sort: { key: "source", direction: "asc" } });
    expect(rows.map((row) => row.source.documentId)).toEqual(["doc-z", "doc-a"]);
  });
});
