import { REVIEW_COLUMNS, ReviewGrid, type ReviewColumn, type ReviewRow } from "./review-grid";
import { PricingPivot, type PivotAxis, type PivotMeasureKind, type PricingPivotResult } from "./pricing-pivot";

// Excel export (Thread 14, build plan §1 "Excel export second" / §7 Track 4).
// The framework-free half of the feature: pure builders that turn the review
// grid + pricing pivots into `write-excel-file` sheet data, and a lazy browser
// trigger that writes the workbook. It reuses Wayfinder's XLSX path — the same
// `write-excel-file` cell shape as apps/web/src/components/admin/field-report-
// export.ts (§9) — so a currency figure is written as a real numeric cell (the
// exit criterion), not text. One sheet holds the review table; one sheet holds
// each pivot (per vendor, per requirement, vendor × requirement). Keeping the
// mapping pure lets the exit test assert the cell types without loading the
// writer; the Playwright e2e opens a real download.

// A `write-excel-file` cell. `type` is the native constructor the library reads
// to decide the Excel cell type; `null` writes a blank cell. A `hyperlink` turns
// a String cell into a clickable link — the review grid's source deep-link.
// Verified against Wayfinder's verified usage, not training data (CLAUDE.md).
export type SheetCell =
  | { value: string; type: StringConstructor; fontWeight?: "bold"; hyperlink?: string }
  | { value: number; type: NumberConstructor }
  | null;

export type SheetData = SheetCell[][];

export interface EvaluationWorkbook {
  readonly sheets: readonly SheetData[];
  readonly sheetNames: readonly string[];
}

const headerCell = (label: string): SheetCell => ({ value: label, type: String, fontWeight: "bold" });

const textCell = (value: string): SheetCell => ({ value, type: String });

const numberCell = (value: number): SheetCell => ({ value, type: Number });

// The source deep-link the review grid's ReviewSourceLink resolves to. Mirrors
// review-view.ts's sourceHref so the exported hyperlink lands at the exact
// document location the in-app grid links to (build plan §5).
const sourceHref = (evaluationId: string, source: ReviewRow["source"]): string => {
  const params = new URLSearchParams({ element: String(source.elementOrder) });
  if (source.page !== null) params.set("page", String(source.page));
  if (source.chunkId !== null) params.set("chunk", source.chunkId);
  return `/evaluations/${evaluationId}/documents/${source.documentId}?${params.toString()}`;
};

// One review row's typed cell → a sheet cell. A numeric column (currency/number)
// with a parseable figure becomes a real Number cell; the source column becomes
// a hyperlink; everything else is text. An empty currency estimate (the null
// description-fallback signal) writes as a blank cell, never a 0.
const reviewCell = (evaluationId: string, column: ReviewColumn, row: ReviewRow): SheetCell => {
  if (column.key === "source") {
    return { value: row.source.label, type: String, hyperlink: sourceHref(evaluationId, row.source) };
  }
  const cell = row.cells[column.key];
  if (cell.display === "") return null;
  if (cell.isNumeric && typeof cell.sortValue === "number") return numberCell(cell.sortValue);
  return textCell(cell.display);
};

// The review table as one sheet: a bold header of every column, then one row
// per review unit with numeric currency/confidence cells and a source
// hyperlink. Pure so the exit test asserts the cell types without the writer.
export const buildReviewSheetData = (grid: ReviewGrid, evaluationId: string): SheetData => {
  const header = REVIEW_COLUMNS.map((column) => headerCell(column.label));
  const body = grid.all().map((row) => REVIEW_COLUMNS.map((column) => reviewCell(evaluationId, column, row)));
  return [header, ...body];
};

const AXIS_HEADERS: Record<PivotAxis, string> = {
  brand: "Vendor",
  requirement: "Requirement",
  "brand-x-requirement": "Vendor",
};

const MEASURE_HEADERS: Record<PivotMeasureKind, string> = {
  sum: "Total (AUD)",
  avg: "Average (AUD)",
};

export interface PivotSheetInput {
  readonly axis: PivotAxis;
  readonly measure: PivotMeasureKind;
  readonly result: PricingPivotResult;
}

// A pivot cell → a sheet cell: a Number when a numeric sample contributed, else
// a blank (so an empty cross-tab intersection is visibly empty, never 0.00 —
// matching pricing-view.ts's display posture but with the real number, not the
// formatted string).
const pivotNumberCell = (cell: { value: number; sampleCount: number }): SheetCell =>
  cell.sampleCount === 0 ? null : numberCell(cell.value);

// One pivot as a sheet. Single-axis: [group, measure] rows. Cross-tab: a column
// per secondary group plus a row total, then a bold column-total footer. The
// numbers are the real PricingPivotResult figures (numeric cells), not the
// formatted display strings (build plan §1 / §9).
export const buildPivotSheetData = (input: PivotSheetInput): SheetData => {
  const { axis, measure, result } = input;
  const primaryHeader = AXIS_HEADERS[axis];
  const measureHeader = MEASURE_HEADERS[measure];

  if (result.secondaryGroups === null) {
    const header = [headerCell(primaryHeader), headerCell(measureHeader)];
    const body = result.rows.map((row) => [textCell(row.key), pivotNumberCell(row.total)]);
    const footer = [headerCell("Total"), pivotNumberCell(result.grandTotal)];
    return [header, ...body, footer];
  }

  const header = [
    headerCell(primaryHeader),
    ...result.secondaryGroups.map((group) => headerCell(group)),
    headerCell(measureHeader),
  ];
  const body = result.rows.map((row) => [
    textCell(row.key),
    ...row.cells.map(pivotNumberCell),
    pivotNumberCell(row.total),
  ]);
  const footer = [
    headerCell("Total"),
    ...result.columnTotals.map(pivotNumberCell),
    pivotNumberCell(result.grandTotal),
  ];
  return [header, ...body, footer];
};

export interface EvaluationWorkbookInput {
  readonly evaluationId: string;
  readonly grid: ReviewGrid;
  readonly pivot: PricingPivot;
}

// The full workbook: the review table first, then one sheet per pivot (per
// vendor, per requirement, vendor × requirement) — all summed, the specialist's
// default lens. The numeric guarantee holds across every sheet.
export const buildEvaluationWorkbook = (input: EvaluationWorkbookInput): EvaluationWorkbook => {
  const { evaluationId, grid, pivot } = input;

  const review = buildReviewSheetData(grid, evaluationId);
  const byVendor = buildPivotSheetData({
    axis: "brand",
    measure: "sum",
    result: pivot.compute({ axis: "brand", measure: "sum" }),
  });
  const byRequirement = buildPivotSheetData({
    axis: "requirement",
    measure: "sum",
    result: pivot.compute({ axis: "requirement", measure: "sum" }),
  });
  const crossTab = buildPivotSheetData({
    axis: "brand-x-requirement",
    measure: "sum",
    result: pivot.compute({ axis: "brand-x-requirement", measure: "sum" }),
  });

  return {
    sheets: [review, byVendor, byRequirement, crossTab],
    sheetNames: ["Review", "Pricing by Vendor", "Pricing by Requirement", "Vendor × Requirement"],
  };
};

const isoDate = (date: Date): string => new Date(date).toISOString().slice(0, 10);

// A slugged, dated filename — mirrors Wayfinder's insightsExportFileName.
export const evaluationExportFileName = (evaluationName: string, date: Date): string => {
  const stem = evaluationName
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return `${stem || "evaluation"}-evaluation-${isoDate(date)}.xlsx`;
};

export interface ExportEvaluationInput {
  readonly evaluationId: string;
  readonly evaluationName: string;
  readonly grid: ReviewGrid;
  readonly pivot: PricingPivot;
}

// Pairs each built sheet's data with its name in the shape `write-excel-file`
// consumes (an array of `{ name, data }` objects — verified against its bundled
// types, not training data — CLAUDE.md). Pure so the mapping is unit-tested
// without the browser writer.
export const toWriterSheets = (
  workbook: EvaluationWorkbook,
): readonly { name: string; data: SheetData }[] =>
  workbook.sheets.map((data, index) => ({ name: workbook.sheetNames[index]!, data }));

export interface WriteEvaluationWorkbookInput {
  readonly evaluationName: string;
  readonly workbook: EvaluationWorkbook;
}

// Writes an already-built workbook to a `.xlsx` in the browser and triggers the
// download. The workbook is built server-side (the fork's `evaluation.workbook`
// procedure) so the write side is the only thing on the client. The writer is
// lazy-loaded (dynamic import) so it stays out of the initial bundle, exactly as
// Wayfinder's exportInsightsXlsx does.
export const writeEvaluationWorkbook = async (
  input: WriteEvaluationWorkbookInput,
): Promise<void> => {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const sheets = toWriterSheets(input.workbook).map((sheet) => ({
    name: sheet.name,
    data: sheet.data as SheetCell[][],
  }));
  await writeXlsxFile(sheets).toFile(evaluationExportFileName(input.evaluationName, new Date()));
};

// Builds the `.xlsx` in the browser and triggers the download. The writer is
// lazy-loaded (dynamic import) so it stays out of the initial bundle, exactly as
// Wayfinder's exportInsightsXlsx does. Multi-sheet: `write-excel-file` takes an
// array of `{ data, name }` sheet objects (verified against its bundled types,
// not training data — CLAUDE.md).
export const exportEvaluationXlsx = async (input: ExportEvaluationInput): Promise<void> => {
  const workbook = buildEvaluationWorkbook(input);
  await writeEvaluationWorkbook({ evaluationName: input.evaluationName, workbook });
};
