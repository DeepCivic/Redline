import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type {
  IMoneySpanStore,
  MoneySpanFilter,
  MoneySpanRow,
} from "./money-span-store";

// The port's spec, proven implementable by an in-memory fake. A money span is an
// addressable, provenance-tagged row — no requirementId, no alignment: attaching a
// span to a requirement happens above this seam, in whichever consumer needs it (the
// grid's extractor and the report assembler both do, differently). The store only
// makes the spans queryable by their womblex
// provenance. `value` crosses as an exact decimal string, never a float — womblex
// writes `decimal128(38,4)` precisely because summing 48,997 amounts accumulates
// float error, and that exactness must survive the seam.
//
// The row is womblex's own span, uninterpreted: three loci, the qualifiers it
// refuses to fold into `value` (`modifier`, `multiplier`, `negative`) and the range
// grouping that tells a lower endpoint from an upper. Reading any of those is a
// consumer's job.

const span = (over: Partial<MoneySpanRow> = {}): MoneySpanRow => ({
  documentId: "hashA",
  locus: "table_cell",
  textSource: null,
  startChar: null,
  endChar: null,
  page: null,
  elementOrder: null,
  parentElementOrder: 4,
  sheet: null,
  rowIndex: 2,
  columnIndex: 1,
  text: "$1,500.50",
  value: "1500.5000",
  currency: "AUD",
  currencySource: "column_header",
  evidence: "header+numeric",
  modifier: null,
  multiplier: null,
  negative: false,
  confidence: 0.9,
  rangeGroup: null,
  rangeRole: null,
  columnId: "elem4:col1",
  context: null,
  ...over,
});

const narrativeSpan = (over: Partial<MoneySpanRow> = {}): MoneySpanRow =>
  span({
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
    context: "the total contract value is $2.4 million over four years",
    ...over,
  });

class InMemoryMoneySpanStore implements IMoneySpanStore {
  constructor(private readonly rows: readonly MoneySpanRow[]) {}

  async fetchByDocument(
    _evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    return ok(this.rows.filter((row) => row.documentId === documentId));
  }

  async fetchByStructure(
    _evaluationId: string,
    filter: MoneySpanFilter,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    return ok(
      this.rows.filter((row) => {
        if (filter.documentId !== undefined && row.documentId !== filter.documentId) return false;
        if (filter.locus !== undefined && row.locus !== filter.locus) return false;
        if (
          filter.parentElementOrder !== undefined &&
          row.parentElementOrder !== filter.parentElementOrder
        ) {
          return false;
        }
        if (filter.currency !== undefined && row.currency !== filter.currency) return false;
        return true;
      }),
    );
  }
}

describe("IMoneySpanStore (in-memory fake) — the money-span query surface", () => {
  it("fetches a document's table-cell spans, value intact as an exact string", async () => {
    const store: IMoneySpanStore = new InMemoryMoneySpanStore([
      span(),
      span({ documentId: "hashB", value: "42.0000" }),
    ]);

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    const [row] = result.data;
    expect(row!.value).toBe("1500.5000");
    expect(row!.currency).toBe("AUD");
    expect(row!.locus).toBe("table_cell");
    expect(row!.parentElementOrder).toBe(4);
  });

  it("addresses spans structurally by (document, table element)", async () => {
    const store: IMoneySpanStore = new InMemoryMoneySpanStore([
      span({ parentElementOrder: 4, columnIndex: 1 }),
      span({ parentElementOrder: 4, rowIndex: 3, columnIndex: 1, value: "980.0000" }),
      span({ parentElementOrder: 9, value: "5.0000" }),
    ]);

    const result = await store.fetchByStructure("eval-1", {
      documentId: "hashA",
      parentElementOrder: 4,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.map((row) => row.value).sort()).toEqual(["1500.5000", "980.0000"]);
  });

  it("keeps a money-marked span whose currency is unresolved (nullable currency)", async () => {
    const store: IMoneySpanStore = new InMemoryMoneySpanStore([
      span({ currency: null, value: "12.3400" }),
    ]);

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.currency).toBeNull();
  });

  it("carries a narrative span on its character offsets, with no cell anchor", async () => {
    const store: IMoneySpanStore = new InMemoryMoneySpanStore([narrativeSpan()]);

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [row] = result.data;
    expect(row!.locus).toBe("narrative");
    expect(row!.startChar).toBe(120);
    expect(row!.endChar).toBe(134);
    expect(row!.textSource).toBe("elements");
    expect(row!.parentElementOrder).toBeNull();
    expect(row!.rowIndex).toBeNull();
    expect(row!.columnIndex).toBeNull();
  });

  it("carries a sheet-cell span on its sheet/row/col anchor", async () => {
    const store: IMoneySpanStore = new InMemoryMoneySpanStore([
      span({
        locus: "sheet_cell",
        parentElementOrder: null,
        elementOrder: 88,
        sheet: "Pricing",
        rowIndex: 12,
        columnIndex: 3,
        columnId: "sheet:Pricing:col3",
      }),
    ]);

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [row] = result.data;
    expect(row!.locus).toBe("sheet_cell");
    expect(row!.sheet).toBe("Pricing");
    expect(row!.elementOrder).toBe(88);
    expect(row!.parentElementOrder).toBeNull();
  });

  it("keeps a qualifier off the value — 'up to $2M' stays $2M plus a modifier", async () => {
    // womblex deliberately never folds `modifier` into `value`. Dropping the
    // column made "up to $2M" indistinguishable from an exact $2M; carrying it
    // is what lets a consumer refuse to read it as one.
    const store: IMoneySpanStore = new InMemoryMoneySpanStore([
      narrativeSpan({ text: "up to $2M", value: "2000000.0000", modifier: "up to", multiplier: "million" }),
    ]);

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.value).toBe("2000000.0000");
    expect(result.data[0]!.modifier).toBe("up to");
    expect(result.data[0]!.multiplier).toBe("million");
  });

  it("tells a range's lower endpoint from its upper", async () => {
    // A range writes two rows. Without the grouping, "$1M–$2M" is two unrelated
    // amounts and anything summing them reports $3M.
    const store: IMoneySpanStore = new InMemoryMoneySpanStore([
      narrativeSpan({ value: "1000000.0000", rangeGroup: 7, rangeRole: "lower" }),
      narrativeSpan({ startChar: 136, endChar: 142, value: "2000000.0000", rangeGroup: 7, rangeRole: "upper" }),
    ]);

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => [row.rangeGroup, row.rangeRole])).toEqual([
      [7, "lower"],
      [7, "upper"],
    ]);
  });

  it("addresses spans structurally by locus", async () => {
    const store: IMoneySpanStore = new InMemoryMoneySpanStore([
      span(),
      narrativeSpan(),
      span({ locus: "sheet_cell", sheet: "Pricing", parentElementOrder: null }),
    ]);

    const result = await store.fetchByStructure("eval-1", { locus: "narrative" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.startChar).toBe(120);
  });
});
