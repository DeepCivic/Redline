import type { EvaluationWorkbook, SheetCell, SheetData } from "./excel-export";

// The report sheet seam (delivery-plan §2 item 1 / architecture §5.1). The other
// half of the export target already exists: buildEvaluationWorkbook turns the grid
// + pivots into `write-excel-file` sheet data. What was missing is the seam where
// an *assembled report* becomes sheets — the half a specialist actually receives.
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
  // Whether an enrichment graph was reachable for this evaluation. A report over a
  // graph-less evaluation carries an explicit unavailability, not a silently
  // thinner report — so the workbook states it rather than leaving it implicit.
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

// The full report workbook: one named report sheet. Mirrors buildEvaluationWorkbook's
// shape so the same toWriterSheets / writeEvaluationWorkbook path serialises it.
export const buildReportWorkbook = (report: AssembledReport): EvaluationWorkbook => ({
  sheets: [buildReportSheetData(report)],
  sheetNames: [REPORT_SHEET_NAME],
});
