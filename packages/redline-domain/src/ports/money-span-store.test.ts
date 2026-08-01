import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type {
  IMoneySpanStore,
  MoneySpanFilter,
  MoneySpanRow,
} from "./money-span-store";

// The port's spec, proven implementable by an in-memory fake. A money span is an
// addressable, provenance-tagged row — no requirementId, no alignment: attaching a
// span to a requirement is the report-assembler LLM's job over the graph (ADR-0017),
// not this seam's. The store only makes the spans queryable by their womblex
// provenance. `value` crosses as an exact decimal string, never a float — womblex
// writes `decimal128(38,4)` precisely because summing 48,997 amounts accumulates
// float error, and that exactness must survive the seam.

const span = (over: Partial<MoneySpanRow> = {}): MoneySpanRow => ({
  documentId: "hashA",
  locus: "table_cell",
  parentElementOrder: 4,
  rowIndex: 2,
  columnIndex: 1,
  text: "$1,500.50",
  value: "1500.5000",
  currency: "AUD",
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
});
