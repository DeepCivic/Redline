import { describe, it, expect } from "vitest";
import type { ChunkRow, MoneySpanRow } from "@redline/redline-domain";
import { resolveChunkForMoneySpan } from "./chunk-element-resolution";

// The delivery-plan exit test: "a money span resolves to the single chunk whose
// element range contains it." redline_money_spans addresses a figure as
// (documentId, parentElementOrder, rowIndex, columnIndex) for a table/sheet cell,
// or (documentId, startChar, endChar) for narrative prose; redline_chunks now
// carries the matching element range each chunk was cut from
// (chunk-element-resolution.ts's docstring explains the per-locus join). These
// fixtures cover the three loci womblex writes, not a single happy path.

const narrativeSpan = (over: Partial<MoneySpanRow> = {}): MoneySpanRow => ({
  documentId: "hashA",
  locus: "narrative",
  textSource: "elements",
  startChar: 120,
  endChar: 134,
  page: 3,
  elementOrder: null,
  parentElementOrder: null,
  sheet: null,
  rowIndex: null,
  columnIndex: null,
  text: "$2.4 million",
  value: "2400000.0000",
  currency: "AUD",
  currencySource: "symbol",
  evidence: "p3",
  modifier: null,
  multiplier: "million",
  negative: false,
  confidence: 0.92,
  rangeGroup: null,
  rangeRole: null,
  columnId: null,
  context: "the total contract value is $2.4 million over four years",
  ...over,
});

const tableCellSpan = (over: Partial<MoneySpanRow> = {}): MoneySpanRow =>
  narrativeSpan({
    locus: "table_cell",
    textSource: null,
    startChar: null,
    endChar: null,
    page: null,
    parentElementOrder: 4,
    rowIndex: 1,
    columnIndex: 2,
    text: "1500.50",
    value: "1500.5000",
    currencySource: "column_header",
    evidence: "header+numeric",
    multiplier: null,
    columnId: "elem4:col2",
    context: null,
    ...over,
  });

const sheetCellSpan = (over: Partial<MoneySpanRow> = {}): MoneySpanRow =>
  tableCellSpan({
    locus: "sheet_cell",
    parentElementOrder: null,
    // The sheet cell's own elem_order — never a table's anchor, per
    // money_stage.py's `_sheet_rows`. Kept here to prove it is NOT what the
    // resolver matches on (a sheet chunk carries no elementOrder to match it).
    elementOrder: 88,
    sheet: "Pricing",
    rowIndex: 12,
    columnIndex: 3,
    currencySource: "number_format",
    evidence: "number_format",
    columnId: "sheet:Pricing:col3",
    ...over,
  });

const narrativeChunk = (over: Partial<ChunkRow> & Pick<ChunkRow, "chunkId">): ChunkRow => ({
  documentId: "hashA",
  chunkIndex: 0,
  contentType: "narrative",
  page: 3,
  text: "…the total contract value is $2.4 million over four years…",
  startChar: 0,
  endChar: 200,
  elementOrder: null,
  ...over,
});

const tableChunk = (over: Partial<ChunkRow> & Pick<ChunkRow, "chunkId">): ChunkRow => ({
  documentId: "hashA",
  chunkIndex: 1,
  contentType: "table",
  page: 4,
  text: "| Item | Amount |\n| --- | --- |\n| Widget | 1500.50 |",
  startChar: null,
  endChar: null,
  elementOrder: 4,
  ...over,
});

describe("resolveChunkForMoneySpan — narrative locus (startChar/endChar overlap)", () => {
  it("resolves to the narrative chunk whose range contains the span", () => {
    const chunks = [
      narrativeChunk({ chunkId: "hashA:0", startChar: 0, endChar: 200 }),
      narrativeChunk({ chunkId: "hashA:1", chunkIndex: 1, startChar: 200, endChar: 400 }),
    ];

    const resolved = resolveChunkForMoneySpan(narrativeSpan(), chunks);

    expect(resolved?.chunkId).toBe("hashA:0");
  });

  it("picks the chunk that actually contains the span, not just the first one", () => {
    const chunks = [
      narrativeChunk({ chunkId: "hashA:0", startChar: 0, endChar: 100 }),
      narrativeChunk({ chunkId: "hashA:1", chunkIndex: 1, startChar: 100, endChar: 400 }),
    ];

    const resolved = resolveChunkForMoneySpan(
      narrativeSpan({ startChar: 120, endChar: 134 }),
      chunks,
    );

    expect(resolved?.chunkId).toBe("hashA:1");
  });

  it("never matches a table chunk, even one with an overlapping-looking range", () => {
    const chunks = [tableChunk({ chunkId: "hashA:0", startChar: 0, endChar: 200 })];

    const resolved = resolveChunkForMoneySpan(narrativeSpan(), chunks);

    expect(resolved).toBeNull();
  });

  it("returns null when no chunk's range contains the span", () => {
    const chunks = [narrativeChunk({ chunkId: "hashA:0", startChar: 500, endChar: 600 })];

    const resolved = resolveChunkForMoneySpan(narrativeSpan(), chunks);

    expect(resolved).toBeNull();
  });

  it("returns null for a chunk lacking a range — pre-migration data, not a crash", () => {
    const chunks = [narrativeChunk({ chunkId: "hashA:0", startChar: undefined, endChar: undefined })];

    const resolved = resolveChunkForMoneySpan(narrativeSpan(), chunks);

    expect(resolved).toBeNull();
  });
});

describe("resolveChunkForMoneySpan — table_cell locus (elementOrder anchor)", () => {
  it("resolves to the table chunk cut from the same table element", () => {
    const chunks = [
      tableChunk({ chunkId: "hashA:1", elementOrder: 4 }),
      tableChunk({ chunkId: "hashA:2", chunkIndex: 2, elementOrder: 9 }),
    ];

    const resolved = resolveChunkForMoneySpan(tableCellSpan({ parentElementOrder: 4 }), chunks);

    expect(resolved?.chunkId).toBe("hashA:1");
  });

  it("returns null when no chunk was cut from that table element", () => {
    const chunks = [tableChunk({ chunkId: "hashA:1", elementOrder: 9 })];

    const resolved = resolveChunkForMoneySpan(tableCellSpan({ parentElementOrder: 4 }), chunks);

    expect(resolved).toBeNull();
  });
});

describe("resolveChunkForMoneySpan — sheet_cell locus (no chunk anchor exists yet)", () => {
  it("returns null: a spreadsheet-sheet chunk carries no elementOrder to match", () => {
    // collect_tables_from_elements leaves elem_order null for every sheet chunk
    // (a sheet has no single anchor element), so the sheet cell's own
    // elem_order (88 here) has nothing on the chunk side to join against.
    const chunks = [tableChunk({ chunkId: "hashA:1", elementOrder: null })];

    const resolved = resolveChunkForMoneySpan(sheetCellSpan(), chunks);

    expect(resolved).toBeNull();
  });
});
