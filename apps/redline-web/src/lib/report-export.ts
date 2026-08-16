// The report sheet seam (architecture §5.1): where an *assembled report* becomes
// sheets — the half a specialist actually receives.
//
// It is split from the assembly loop (fork-side, ReportAssembler in
// @rbrasier/adapters) because it is independently testable: a fixed report
// structure exports correctly whether a model or a fixture produced it. The seam
// takes the loop's output as *data* — the transport is deterministic, so the
// builder never calls a model and never reaches the fork. redline-web must not
// import Wayfinder, so the report shape is declared here, structurally mirroring
// the assembler's AssembledReport so its output crosses as a plain value.
//
// Provenance is the load-bearing invariant (architecture §5.1): every transferred
// passage keeps its chunkId citation and every financial expression keeps its
// provenance anchor, exact value and currency as the assembler carried them — the
// passage text stays byte-identical (a plain text cell, never re-parsed), and the
// value stays uninterpreted (never re-read as a number). A specialist opening the
// workbook can resolve every fact back to a source location.

// A `write-excel-file` cell. `type` is the native constructor the library reads
// to decide the Excel cell type; `null` writes a blank cell. Verified against
// write-excel-file@4.1.1's bundled `types/SheetData.d.ts` +
// `types/CellStyleProperties.d.ts`, not training data (CLAUDE.md) — which is why
// there is no `hyperlink`: the library carries no such cell property, so
// declaring one would promise a deep-link it silently writes as plain text.
export type SheetCell =
  | { value: string; type: StringConstructor; fontWeight?: "bold" }
  | { value: number; type: NumberConstructor }
  | null;

export type SheetData = SheetCell[][];

export interface ReportWorkbook {
  readonly sheets: readonly SheetData[];
  readonly sheetNames: readonly string[];
}

// One transferred passage: a chunk's text (or a contiguous fragment of it), cited
// by the stable chunkId it came from.
export interface TransferredPassage {
  readonly chunkId: string;
  readonly text: string;
}

// One financial expression carried as womblex wrote it — exact value, currency and
// the provenance anchor it resolves back to. Uninterpreted: never totalled,
// converted or re-parsed to a number cell.
export interface ReportFinancialExpression {
  readonly documentId: string;
  readonly provenanceAnchor: string;
  readonly value: string;
  readonly currency: string;
}

export interface ReportSection {
  readonly heading: string;
  // The assembler's own connective prose. Not a fact — facts live in the passages
  // and expressions the section cites.
  readonly body: string;
  readonly transferredPassages: readonly TransferredPassage[];
  readonly financialExpressions: readonly ReportFinancialExpression[];
  // A section the assembler could not ground in retrievable data. It carries no
  // passages and names what it could not reach, rather than being written anyway
  // from the model's own knowledge.
  readonly unreachable: boolean;
  readonly unreachableNote?: string;
}

export interface AssembledReport {
  // Whether an enrichment graph was reachable for this corpus. A report over a
  // graph-less corpus carries an explicit unavailability, not a silently thinner
  // report — so the workbook states it rather than leaving it implicit.
  readonly graphAvailable: boolean;
  readonly sections: readonly ReportSection[];
}

export const REPORT_SHEET_NAME = "Report";

const headerCell = (label: string): SheetCell => ({ value: label, type: String, fontWeight: "bold" });

const textCell = (value: string): SheetCell => ({ value, type: String });

// A fresh blank row each call — never a shared reference, so a returned sheet is
// fully independent data no consumer can alias-mutate.
const blankRow = (): SheetCell[] => [null];

// One section → its rows: a bold "Section" label + the heading, the connective
// body, then a labelled row per transferred passage (text + its chunkId citation)
// and per financial expression (value + currency + provenance anchor). An
// unreachable section renders its note instead of passages, so the specialist sees
// what the assembler could not reach rather than an empty gap.
const sectionRows = (section: ReportSection): SheetData => {
  const rows: SheetData = [[headerCell("Section"), headerCell(section.heading)]];

  if (section.body.trim() !== "") rows.push([null, textCell(section.body)]);

  if (section.unreachable) {
    rows.push([textCell("Unreachable"), textCell(section.unreachableNote ?? "")]);
    return rows;
  }

  for (const passage of section.transferredPassages) {
    rows.push([textCell("Passage"), textCell(passage.text), textCell(passage.chunkId)]);
  }

  for (const expression of section.financialExpressions) {
    rows.push([
      textCell("Financial"),
      textCell(expression.value),
      textCell(expression.currency),
      textCell(expression.documentId),
      textCell(expression.provenanceAnchor),
    ]);
  }

  return rows;
};

// The assembled report as one sheet: a graph-availability header, then each
// section in report order. Pure so the exit test asserts the cell shape and the
// intact provenance without loading the writer.
export const buildReportSheetData = (report: AssembledReport): SheetData => {
  const availability: SheetCell[] = [
    headerCell("Enrichment graph"),
    textCell(report.graphAvailable ? "Yes" : "No"),
  ];

  const body = report.sections.flatMap((section) => [...sectionRows(section), blankRow()]);

  return [availability, blankRow(), ...body];
};

// The full report workbook: one named report sheet.
export const buildReportWorkbook = (report: AssembledReport): ReportWorkbook => ({
  sheets: [buildReportSheetData(report)],
  sheetNames: [REPORT_SHEET_NAME],
});

// Pairs each built sheet's data with its name in the shape `write-excel-file`
// consumes: an array of `{ data, sheet }` objects. The name key is **`sheet`**,
// not `name` — verified against write-excel-file@4.1.1's
// `types/SheetOptions.d.ts` and its runtime default
// (`sheetOptions.sheet || "Sheet" + (i + 1)`), so a `name` key is ignored and the
// tab silently comes out as "Sheet1". Pure, so the mapping is unit-tested without
// the browser writer.
export const toWriterSheets = (
  workbook: ReportWorkbook,
): readonly { sheet: string; data: SheetData }[] =>
  workbook.sheets.map((data, index) => ({ sheet: workbook.sheetNames[index]!, data }));

const isoDate = (date: Date): string => new Date(date).toISOString().slice(0, 10);

// A slugged, dated filename — mirrors Wayfinder's insightsExportFileName.
export const reportExportFileName = (corpusId: string, date: Date): string => {
  const stem = corpusId
    .trim()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return `${stem || "corpus"}-report-${isoDate(date)}.xlsx`;
};

export interface WriteReportWorkbookInput {
  readonly corpusId: string;
  readonly workbook: ReportWorkbook;
}

// Writes an already-built workbook to a `.xlsx` in the browser and triggers the
// download. The workbook is built server-side so the write side is the only thing
// on the client, and the writer is lazy-loaded (dynamic import) so it stays out
// of the initial bundle — exactly as Wayfinder's exportInsightsXlsx does.
export const writeReportWorkbook = async (input: WriteReportWorkbookInput): Promise<void> => {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const sheets = toWriterSheets(input.workbook).map((entry) => ({
    sheet: entry.sheet,
    data: entry.data as SheetCell[][],
  }));
  await writeXlsxFile(sheets).toFile(reportExportFileName(input.corpusId, new Date()));
};
