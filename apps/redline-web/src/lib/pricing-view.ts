import type { PivotAxis, PivotMeasureKind, PricingPivotResult } from "./pricing-pivot";

// View model for the pricing pivots (Thread 13). A pure PricingPivotResult →
// presentation-ready table the Next.js/React shell binds to: a header row (the
// group axis label + one column per secondary group, or a single measure
// column), a body row per primary group with formatted currency cells + a row
// total, and a footer of column totals. Currency is formatted here for display
// only — the numeric PricingPivotResult stays the source of truth (and the
// XLSX export, Thread 14, writes the real numbers, not these strings). Matches
// review-view.ts / view.ts (ADR-0006): keep the DOM dumb and the shaping tested.

export interface PivotTableCell {
  // Formatted currency (or an average) for display; empty when no numeric
  // sample contributed, so "no figure yet" reads as blank rather than "$0.00".
  readonly display: string;
  readonly value: number;
  readonly sampleCount: number;
}

export interface PivotTableRow {
  readonly key: string;
  readonly cells: readonly PivotTableCell[];
  readonly total: PivotTableCell;
}

export interface PivotTableView {
  readonly axis: PivotAxis;
  readonly measure: PivotMeasureKind;
  readonly primaryHeader: string;
  // Column headers for a cross-tab (the secondary groups); empty for a single-
  // axis pivot, whose one measure column is labelled by `measureHeader`.
  readonly columnHeaders: readonly string[];
  readonly measureHeader: string;
  readonly rows: readonly PivotTableRow[];
  readonly columnTotals: readonly PivotTableCell[];
  readonly grandTotal: PivotTableCell;
  readonly hasNumericData: boolean;
}

export interface RenderPivotInput {
  readonly axis: PivotAxis;
  readonly measure: PivotMeasureKind;
  readonly result: PricingPivotResult;
}

const AXIS_HEADERS: Record<PivotAxis, string> = {
  brand: "Vendor",
  requirement: "Requirement",
  "brand-x-requirement": "Vendor",
};

const MEASURE_HEADERS: Record<PivotMeasureKind, string> = {
  sum: "Total (AUD)",
  avg: "Average (AUD)",
};

const formatCurrency = (value: number): string =>
  value.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

const cellView = (cell: { value: number; sampleCount: number }): PivotTableCell => ({
  // A cell with no numeric sample reads blank, not "$0.00", so an empty
  // brand×requirement intersection is visibly empty.
  display: cell.sampleCount === 0 ? "" : formatCurrency(cell.value),
  value: cell.value,
  sampleCount: cell.sampleCount,
});

export const renderPivotView = (input: RenderPivotInput): PivotTableView => {
  const { axis, measure, result } = input;

  return {
    axis,
    measure,
    primaryHeader: AXIS_HEADERS[axis],
    columnHeaders: result.secondaryGroups ? [...result.secondaryGroups] : [],
    measureHeader: MEASURE_HEADERS[measure],
    rows: result.rows.map((row) => ({
      key: row.key,
      cells: row.cells.map(cellView),
      total: cellView(row.total),
    })),
    columnTotals: result.columnTotals.map(cellView),
    grandTotal: cellView(result.grandTotal),
    hasNumericData: result.hasNumericData,
  };
};
