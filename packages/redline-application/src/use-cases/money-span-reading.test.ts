import { describe, it, expect } from "vitest";
import type { MoneySpanRow } from "@redline/redline-domain";
import { readDocumentMoney } from "./money-span-reading";

// The grid's reading of a document's money spans. The store holds womblex's spans
// uninterpreted; this is the one place that decides what a single AUD figure on the
// review grid means, and it is deliberately the only such reading — the report tool
// surface serves the same rows without it.
//
// Three rules, each fixing an amount that used to be counted twice or read as exact:
//   1. a table prices the document — narrative amounts are excluded when cells exist;
//   2. a range is one amount, counted at its upper endpoint, not two;
//   3. a qualified amount ("up to", "at least") is a bound, and the description says so.

const cell = (over: Partial<MoneySpanRow> = {}): MoneySpanRow => ({
  documentId: "doc-a",
  locus: "table_cell",
  textSource: null,
  startChar: null,
  endChar: null,
  page: null,
  elementOrder: null,
  parentElementOrder: 4,
  sheet: null,
  rowIndex: 1,
  columnIndex: 2,
  text: "1500.50",
  value: "1500.5000",
  currency: "AUD",
  currencySource: "column_header",
  evidence: "header+numeric",
  modifier: null,
  multiplier: null,
  negative: false,
  confidence: 0.92,
  rangeGroup: null,
  rangeRole: null,
  columnId: "elem4:col2",
  context: null,
  ...over,
});

const narrative = (over: Partial<MoneySpanRow> = {}): MoneySpanRow =>
  cell({
    locus: "narrative",
    textSource: "elements",
    startChar: 120,
    endChar: 134,
    page: 3,
    parentElementOrder: null,
    rowIndex: null,
    columnIndex: null,
    columnId: null,
    text: "$2.4 million",
    value: "2400000.0000",
    currencySource: "symbol",
    evidence: "p3",
    multiplier: "million",
    ...over,
  });

describe("readDocumentMoney — a table prices the document", () => {
  it("excludes narrative amounts when the document also prices in cells", () => {
    const spans = [
      cell({ rowIndex: 1, value: "1000.0000" }),
      cell({ rowIndex: 2, value: "500.0000" }),
      narrative({ startChar: 40, value: "1500.0000", text: "$1,500 in total" }),
    ];

    const reading = readDocumentMoney(spans);

    expect(reading.estimateAud).toBe(1500);
    expect(reading.countedSpans).toHaveLength(2);
    expect(reading.countedSpans.every((span) => span.locus !== "narrative")).toBe(true);
    expect(reading.description).toContain("1 narrative span excluded");
  });

  it("counts sheet cells alongside table cells — both are cell loci", () => {
    const spans = [
      cell({ locus: "table_cell", value: "100.0000" }),
      cell({ locus: "sheet_cell", sheet: "Pricing", value: "200.0000" }),
      narrative({ value: "300.0000" }),
    ];

    const reading = readDocumentMoney(spans);

    expect(reading.estimateAud).toBe(300);
    expect(reading.countedSpans).toHaveLength(2);
  });

  it("falls back to narrative amounts for a document that prices only in prose", () => {
    const spans = [
      narrative({ startChar: 10, value: "1200.0000" }),
      narrative({ startChar: 90, value: "300.0000" }),
    ];

    const reading = readDocumentMoney(spans);

    expect(reading.estimateAud).toBe(1500);
    expect(reading.countedSpans).toHaveLength(2);
    expect(reading.description).not.toContain("excluded");
  });
});

describe("readDocumentMoney — a range is one amount", () => {
  it("counts a range once, at its upper endpoint", () => {
    const spans = [
      narrative({ startChar: 10, value: "1000000.0000", rangeGroup: 1, rangeRole: "lower" }),
      narrative({ startChar: 22, value: "2000000.0000", rangeGroup: 1, rangeRole: "upper" }),
    ];

    const reading = readDocumentMoney(spans);

    expect(reading.estimateAud).toBe(2000000);
    expect(reading.countedSpans).toHaveLength(1);
    expect(reading.countedSpans[0]!.rangeRole).toBe("upper");
    expect(reading.description).toContain("1 range counted at its upper endpoint");
  });

  it("keeps two distinct ranges apart, counting each once", () => {
    const spans = [
      narrative({ startChar: 10, value: "100.0000", rangeGroup: 1, rangeRole: "lower" }),
      narrative({ startChar: 20, value: "200.0000", rangeGroup: 1, rangeRole: "upper" }),
      narrative({ startChar: 60, value: "30.0000", rangeGroup: 2, rangeRole: "lower" }),
      narrative({ startChar: 70, value: "40.0000", rangeGroup: 2, rangeRole: "upper" }),
    ];

    const reading = readDocumentMoney(spans);

    expect(reading.estimateAud).toBe(240);
    expect(reading.countedSpans).toHaveLength(2);
  });

  it("does not merge equal range groups from different loci", () => {
    // womblex restarts its range counter per scanned text (`find_money` owns the
    // counter), so group 1 in the narrative is unrelated to group 1 elsewhere.
    const spans = [
      narrative({ startChar: 10, value: "100.0000", rangeGroup: 1, rangeRole: "lower" }),
      narrative({ startChar: 20, value: "200.0000", rangeGroup: 1, rangeRole: "upper" }),
      narrative({
        textSource: "normalised",
        startChar: 10,
        value: "5.0000",
        rangeGroup: 1,
        rangeRole: "lower",
      }),
      narrative({
        textSource: "normalised",
        startChar: 20,
        value: "9.0000",
        rangeGroup: 1,
        rangeRole: "upper",
      }),
    ];

    const reading = readDocumentMoney(spans);

    expect(reading.countedSpans).toHaveLength(2);
    expect(reading.estimateAud).toBe(209);
  });

  it("stands in the surviving endpoint when a range lost its upper row", () => {
    const spans = [
      narrative({ startChar: 10, value: "750.0000", rangeGroup: 1, rangeRole: "lower" }),
    ];

    const reading = readDocumentMoney(spans);

    expect(reading.estimateAud).toBe(750);
    expect(reading.countedSpans).toHaveLength(1);
  });
});

describe("readDocumentMoney — a qualified amount is a bound, not an exact figure", () => {
  it("reports a ceiling modifier rather than presenting the total as exact", () => {
    const spans = [narrative({ value: "2000000.0000", modifier: "up to" })];

    const reading = readDocumentMoney(spans);

    expect(reading.estimateAud).toBe(2000000);
    expect(reading.description).toContain("1 amount is a ceiling");
  });

  it("reports a floor modifier separately from a ceiling", () => {
    const spans = [
      narrative({ startChar: 10, value: "100.0000", modifier: "at least" }),
      narrative({ startChar: 50, value: "200.0000", modifier: "no more than" }),
    ];

    const reading = readDocumentMoney(spans);

    expect(reading.description).toContain("1 amount is a floor");
    expect(reading.description).toContain("1 amount is a ceiling");
  });

  it("treats an approximation as the estimate itself, still flagged as inexact", () => {
    const spans = [narrative({ value: "50000.0000", modifier: "approximately" })];

    const reading = readDocumentMoney(spans);

    expect(reading.estimateAud).toBe(50000);
    expect(reading.description).toContain("1 amount is approximate");
  });

  it("reports an unrecognised qualifier rather than silently dropping it", () => {
    const spans = [narrative({ value: "10.0000", modifier: "thereabouts" })];

    const reading = readDocumentMoney(spans);

    expect(reading.description).toContain("1 amount is qualified");
  });

  it("says nothing about bounds when every amount is unqualified", () => {
    const reading = readDocumentMoney([narrative({ value: "10.0000" })]);

    expect(reading.description).not.toContain("ceiling");
    expect(reading.description).not.toContain("floor");
    expect(reading.description).not.toContain("approximate");
  });
});

describe("readDocumentMoney — arithmetic and labelling", () => {
  it("sums in fixed point, with no float drift across amounts", () => {
    const spans = [cell({ rowIndex: 1, value: "0.1000" }), cell({ rowIndex: 2, value: "0.2000" })];

    expect(readDocumentMoney(spans).estimateAud).toBe(0.3);
  });

  it("carries a negative amount through as a credit", () => {
    const spans = [
      cell({ rowIndex: 1, value: "1000.0000" }),
      cell({ rowIndex: 2, value: "-250.0000", negative: true }),
    ];

    expect(readDocumentMoney(spans).estimateAud).toBe(750);
  });

  it("labels a single resolved currency, and says so when they differ", () => {
    const single = readDocumentMoney([cell({ currency: "AUD" })]);
    const mixed = readDocumentMoney([
      cell({ rowIndex: 1, currency: "AUD" }),
      cell({ rowIndex: 2, currency: "NZD" }),
    ]);

    expect(single.description).toContain("AUD");
    expect(mixed.description).toContain("mixed currency");
  });

  it("returns an empty reading for a document with no spans at all", () => {
    const reading = readDocumentMoney([]);

    expect(reading.countedSpans).toHaveLength(0);
    expect(reading.estimateAud).toBe(0);
  });

  it("counts each amount exactly once across all three defects at once", () => {
    // The exit case: a document carrying a range, a modifier and a narrative total.
    // The expectation is derived from the spans, never from a written-down total.
    const countedCells = [
      cell({ rowIndex: 1, value: "1200.0000" }),
      cell({ rowIndex: 2, value: "800.0000", modifier: "up to" }),
    ];
    const spans = [
      ...countedCells,
      narrative({ startChar: 10, value: "2000.0000", text: "total contract value $2,000" }),
      narrative({ startChar: 90, value: "500.0000", rangeGroup: 1, rangeRole: "lower" }),
      narrative({ startChar: 99, value: "900.0000", rangeGroup: 1, rangeRole: "upper" }),
    ];

    const reading = readDocumentMoney(spans);

    const expected = countedCells.reduce((sum, span) => sum + Number(span.value), 0);
    expect(reading.estimateAud).toBe(expected);
    expect(reading.countedSpans).toHaveLength(countedCells.length);
    expect(reading.description).toContain("3 narrative spans excluded");
    expect(reading.description).toContain("1 amount is a ceiling");
  });
});
