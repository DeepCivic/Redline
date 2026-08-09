import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isOk } from "@redline/redline-domain";
import { applyMigrations } from "./apply-migrations";
import { schema } from "./db";
import { redlineEvaluations, redlineMoneySpans, type NewMoneySpanRow } from "./schema";
import { DrizzleMoneySpanStore } from "./drizzle-money-span-store";

// A real Postgres round-trip in-process (PGlite = Postgres in WASM), loaded from
// the same migration SQL that ships. The store is read-only over spans the
// sidecar's load path writes; here the test seeds the table directly (standing in
// for that Python load) so the query surface is provable without the sidecar.
//
// The row under test is womblex's full span — three loci, the qualifiers it never
// folds into `value`, and the range grouping — so the assertions here are
// field-by-field, not on a total.

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
let store: DrizzleMoneySpanStore;

const seedEvaluation = async (id: string) => {
  await database.insert(redlineEvaluations).values({ id, name: "RFT", stage: "review" });
};

// A header-evidenced bare-number table cell — the ~98.7% case: the cell text is a
// plain number, its money-ness and currency came from the column verdict.
const tableCell = (over: Partial<NewMoneySpanRow> & { id: string }): NewMoneySpanRow => ({
  evaluationId: "eval-1",
  documentId: "hashA",
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

const narrative = (over: Partial<NewMoneySpanRow> & { id: string }): NewMoneySpanRow =>
  tableCell({
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
    context: "the total contract value is $2.4 million over four years",
    ...over,
  });

const sheetCell = (over: Partial<NewMoneySpanRow> & { id: string }): NewMoneySpanRow =>
  tableCell({
    locus: "sheet_cell",
    parentElementOrder: null,
    elementOrder: 88,
    sheet: "Pricing",
    rowIndex: 12,
    columnIndex: 3,
    currencySource: "number_format",
    evidence: "number_format",
    columnId: "sheet:Pricing:col3",
    ...over,
  });

const seedSpan = async (row: NewMoneySpanRow) => {
  await database.insert(redlineMoneySpans).values(row);
};

beforeEach(async () => {
  pg = new PGlite();
  await applyMigrations((sql) => pg.exec(sql));
  database = drizzle(pg, { schema });
  store = new DrizzleMoneySpanStore(database);
  await seedEvaluation("eval-1");
});

afterEach(async () => {
  await pg.close();
});

describe("DrizzleMoneySpanStore — round-trip", () => {
  it("reads a table-cell span back field by field, with the value exact (no float drift)", async () => {
    await seedSpan(tableCell({ id: "s1" }));

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([
      {
        documentId: "hashA",
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
        // Exact decimal string, not a rounded float — the whole reason the column
        // is numeric(38,4). "1500.5000" must not come back as 1500.5 or "1500.5".
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
      },
    ]);
  });

  it("reads a narrative span back on its character offsets, with no cell anchor", async () => {
    await seedSpan(narrative({ id: "n1" }));

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [row] = result.data;
    expect(row!.locus).toBe("narrative");
    expect(row!.textSource).toBe("elements");
    expect(row!.startChar).toBe(120);
    expect(row!.endChar).toBe(134);
    expect(row!.page).toBe(3);
    expect(row!.multiplier).toBe("million");
    expect(row!.context).toBe("the total contract value is $2.4 million over four years");
    expect(row!.parentElementOrder).toBeNull();
    expect(row!.rowIndex).toBeNull();
    expect(row!.columnIndex).toBeNull();
  });

  it("reads a sheet-cell span back on its sheet/row/col anchor", async () => {
    await seedSpan(sheetCell({ id: "sc1" }));

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [row] = result.data;
    expect(row!.locus).toBe("sheet_cell");
    expect(row!.sheet).toBe("Pricing");
    expect(row!.elementOrder).toBe(88);
    expect(row!.rowIndex).toBe(12);
    expect(row!.columnIndex).toBe(3);
    expect(row!.parentElementOrder).toBeNull();
  });

  it("keeps a qualifier off the value — 'up to $2M' stays $2M plus a modifier", async () => {
    await seedSpan(
      narrative({
        id: "q1",
        text: "up to $2M",
        value: "2000000.0000",
        modifier: "up to",
        multiplier: "million",
      }),
    );

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.value).toBe("2000000.0000");
    expect(result.data[0]!.modifier).toBe("up to");
  });

  it("keeps a range's two endpoints distinguishable", async () => {
    await seedSpan(
      narrative({ id: "r-lower", value: "1000000.0000", rangeGroup: 7, rangeRole: "lower" }),
    );
    await seedSpan(
      narrative({
        id: "r-upper",
        startChar: 136,
        endChar: 142,
        value: "2000000.0000",
        rangeGroup: 7,
        rangeRole: "upper",
      }),
    );

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => [row.rangeGroup, row.rangeRole])).toEqual([
      [7, "lower"],
      [7, "upper"],
    ]);
  });

  it("stores a negative amount with its sign already applied", async () => {
    await seedSpan(tableCell({ id: "neg", text: "(1,200.00)", value: "-1200.0000", negative: true }));

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.value).toBe("-1200.0000");
    expect(result.data[0]!.negative).toBe(true);
  });

  it("orders a document's spans deterministically across all three loci", async () => {
    await seedSpan(tableCell({ id: "t-late", parentElementOrder: 9, value: "3.0000" }));
    await seedSpan(sheetCell({ id: "s-any", value: "4.0000" }));
    await seedSpan(tableCell({ id: "t-early", parentElementOrder: 4, value: "1.0000" }));
    await seedSpan(narrative({ id: "n-any", startChar: 5, endChar: 9, value: "2.0000" }));

    const first = await store.fetchByDocument("eval-1", "hashA");
    const second = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.data.map((row) => row.value)).toEqual(["2.0000", "4.0000", "1.0000", "3.0000"]);
    expect(second.data.map((row) => row.value)).toEqual(first.data.map((row) => row.value));
  });

  it("addresses spans structurally by (document, table element)", async () => {
    await seedSpan(tableCell({ id: "a1", parentElementOrder: 4, value: "10.0000" }));
    await seedSpan(tableCell({ id: "a2", parentElementOrder: 4, rowIndex: 5, value: "20.0000" }));
    await seedSpan(tableCell({ id: "b1", parentElementOrder: 9, value: "99.0000" }));

    const result = await store.fetchByStructure("eval-1", {
      documentId: "hashA",
      parentElementOrder: 4,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.value)).toEqual(["10.0000", "20.0000"]);
  });

  it("matches no narrative span when filtering on a table-element anchor", async () => {
    // parentElementOrder is the table-cell anchor; a narrative span has none, so
    // this filter is blind to prose amounts by construction. Asserted rather than
    // discovered — a report tool that only ever filters structurally would
    // otherwise silently never see them.
    await seedSpan(narrative({ id: "n1" }));
    await seedSpan(tableCell({ id: "t1", value: "10.0000" }));

    const result = await store.fetchByStructure("eval-1", { parentElementOrder: 4 });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.locus).toBe("table_cell");
  });

  it("addresses spans structurally by locus", async () => {
    await seedSpan(narrative({ id: "n1" }));
    await seedSpan(tableCell({ id: "t1", value: "10.0000" }));
    await seedSpan(sheetCell({ id: "sc1", value: "20.0000" }));

    const result = await store.fetchByStructure("eval-1", { locus: "narrative" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.startChar).toBe(120);
  });

  it("filters structurally by currency", async () => {
    await seedSpan(tableCell({ id: "aud", value: "10.0000", currency: "AUD" }));
    await seedSpan(tableCell({ id: "usd", rowIndex: 3, value: "20.0000", currency: "USD" }));

    const result = await store.fetchByStructure("eval-1", { currency: "USD" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.value).toBe("20.0000");
  });

  it("keeps a money-marked span whose currency is unresolved (null currency)", async () => {
    await seedSpan(tableCell({ id: "n1", value: "12.3400", currency: null, currencySource: null }));

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.currency).toBeNull();
    expect(result.data[0]!.currencySource).toBeNull();
  });

  it("scopes spans by evaluation", async () => {
    await seedEvaluation("eval-2");
    await seedSpan(tableCell({ id: "e1", evaluationId: "eval-1", value: "1.0000" }));
    await seedSpan(tableCell({ id: "e2", evaluationId: "eval-2", value: "2.0000" }));

    const result = await store.fetchByDocument("eval-2", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.value)).toEqual(["2.0000"]);
  });

  it("returns an empty result for a document with no spans, not an error", async () => {
    const result = await store.fetchByDocument("eval-1", "no-such-doc");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([]);
  });
});

describe("redline_money_spans migration idempotency", () => {
  it("applies the migrations a second time without error", async () => {
    await expect(applyMigrations((sql) => pg.exec(sql))).resolves.toBeUndefined();
    await seedSpan(tableCell({ id: "after", value: "5.0000" }));
    const result = await store.fetchByDocument("eval-1", "hashA");
    expect(isOk(result)).toBe(true);
  });
});
