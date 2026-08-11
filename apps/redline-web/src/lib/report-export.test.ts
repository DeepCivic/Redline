import { describe, it, expect } from "vitest";
import { toWriterSheets } from "./excel-export";
import {
  buildReportSheetData,
  buildReportWorkbook,
  REPORT_SHEET_NAME,
  type AssembledReport,
} from "./report-export";

// The report sheet seam (delivery-plan §2 item 1 / architecture §5.1). An
// assembled report — an ordered list of provenance-grounded sections, whether a
// model or a fixture produced it — renders to a workbook a specialist can open.
// The exit criterion is proven here at the sheet-data layer (the deterministic
// mapping the browser writer serialises): a fixed report structure renders with
// its provenance intact — every transferred passage keeps its chunkId citation
// and every financial expression keeps its provenance anchor, value and currency
// as the assembler carried them. Transport is deterministic (architecture §5.1:
// the assembler chooses prose, never data), so the test asserts against the
// builder, not by opening the file.

const report = (over: Partial<AssembledReport> = {}): AssembledReport => ({
  graphAvailable: true,
  sections: [],
  ...over,
});

const groundedSection = {
  heading: "Data residency",
  body: "Both vendors host in-region.",
  transferredPassages: [
    { chunkId: "doc-a:2", text: "All data is stored in Australian data centres." },
    { chunkId: "doc-b:5", text: "Hosting is sovereign, ap-southeast-2 only." },
  ],
  financialExpressions: [
    { documentId: "doc-a", provenanceAnchor: "doc-a#cell:3,2", value: "1500.50", currency: "AUD" },
  ],
  unreachable: false,
} as const;

const unreachableSection = {
  heading: "Integration topology",
  body: "",
  transferredPassages: [],
  financialExpressions: [],
  unreachable: true,
  unreachableNote: "No enrichment graph is loaded for this evaluation.",
} as const;

describe("buildReportSheetData", () => {
  it("writes each section's heading as a bold cell in report order", () => {
    const data = buildReportSheetData(
      report({ sections: [groundedSection, { ...groundedSection, heading: "Support" }] }),
    );

    // Both headings appear as bold cells, first section before second.
    const firstHeading = data.findIndex((row) => row[1]?.value === "Data residency");
    const secondHeading = data.findIndex((row) => row[1]?.value === "Support");
    expect(firstHeading).toBeGreaterThanOrEqual(0);
    expect(secondHeading).toBeGreaterThan(firstHeading);
    expect(data[firstHeading]![1]).toMatchObject({ type: String, fontWeight: "bold" });
  });

  it("writes a transferred passage with its chunkId citation intact (the provenance claim)", () => {
    const data = buildReportSheetData(report({ sections: [groundedSection] }));

    const passageRow = data.find(
      (row) => row.some((cell) => cell?.value === "All data is stored in Australian data centres."),
    );
    expect(passageRow).toBeDefined();
    // The passage text is a plain text cell (byte-identical — never a formula/number).
    const textCell = passageRow!.find(
      (cell) => cell?.value === "All data is stored in Australian data centres.",
    );
    expect(textCell).toMatchObject({ type: String });
    // Its chunkId citation rides alongside it, so the fact resolves to a source.
    const citationCell = passageRow!.find((cell) => cell?.value === "doc-a:2");
    expect(citationCell).toMatchObject({ type: String });
  });

  it("writes a financial expression with its value, currency and provenance anchor", () => {
    const data = buildReportSheetData(report({ sections: [groundedSection] }));

    const expressionRow = data.find((row) => row.some((cell) => cell?.value === "doc-a#cell:3,2"));
    expect(expressionRow).toBeDefined();
    // The value is carried verbatim as the assembler wrote it — a text cell, never
    // re-parsed to a number (an uninterpreted financial expression, architecture §5 inv 7).
    expect(expressionRow!.some((cell) => cell?.value === "1500.50" && cell?.type === String)).toBe(true);
    expect(expressionRow!.some((cell) => cell?.value === "AUD")).toBe(true);
    expect(expressionRow!.some((cell) => cell?.value === "doc-a")).toBe(true);
  });

  it("renders an unreachable section with its note, and no invented passages", () => {
    const data = buildReportSheetData(report({ sections: [unreachableSection] }));

    const headingRow = data.find((row) => row[1]?.value === "Integration topology");
    expect(headingRow).toBeDefined();
    // Its note surfaces so the specialist sees what the assembler could not reach.
    const noteRow = data.find(
      (row) => row.some((cell) => cell?.value === "No enrichment graph is loaded for this evaluation."),
    );
    expect(noteRow).toBeDefined();
    // No passage or expression rows for an unreachable section.
    expect(data.every((row) => row.every((cell) => cell?.value !== "doc-a:2"))).toBe(true);
  });

  it("carries the graph availability so a report over a graph-less evaluation says so", () => {
    const withoutGraph = buildReportSheetData(report({ graphAvailable: false, sections: [] }));
    const availabilityRow = withoutGraph.find((row) =>
      row.some((cell) => typeof cell?.value === "string" && cell.value.includes("graph")),
    );
    expect(availabilityRow).toBeDefined();
    expect(availabilityRow!.some((cell) => cell?.value === "false" || cell?.value === "No")).toBe(true);
  });

  it("is a pure function — the same report renders to the same sheet twice", () => {
    const input = report({ sections: [groundedSection, unreachableSection] });
    expect(buildReportSheetData(input)).toEqual(buildReportSheetData(input));
  });
});

describe("buildReportWorkbook", () => {
  it("produces one named report sheet", () => {
    const workbook = buildReportWorkbook(report({ sections: [groundedSection] }));

    expect(workbook.sheetNames).toEqual([REPORT_SHEET_NAME]);
    expect(workbook.sheets).toHaveLength(1);
    expect(workbook.sheets[0]).toEqual(buildReportSheetData(report({ sections: [groundedSection] })));
  });

  it("renders an empty report to a workbook a specialist can still open", () => {
    const workbook = buildReportWorkbook(report({ sections: [] }));
    expect(workbook.sheets).toHaveLength(1);
    // The sheet is never empty — it always carries the graph-availability header row.
    expect(workbook.sheets[0].length).toBeGreaterThan(0);
  });

  it("flows through the same writer seam the evaluation workbook uses", () => {
    // The report workbook is an EvaluationWorkbook, so toWriterSheets /
    // writeEvaluationWorkbook serialise it unchanged — the report is delivered
    // down the same deterministic browser-writer path, not a second one.
    const workbook = buildReportWorkbook(report({ sections: [groundedSection] }));
    const sheets = toWriterSheets(workbook);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe(REPORT_SHEET_NAME);
    expect(sheets[0]!.data).toBe(workbook.sheets[0]);
  });
});
