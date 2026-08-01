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

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
let store: DrizzleMoneySpanStore;

const seedEvaluation = async (id: string) => {
  await database.insert(redlineEvaluations).values({ id, name: "RFT", stage: "review" });
};

const seedSpan = async (over: Partial<NewMoneySpanRow> & { id: string }) => {
  const row: NewMoneySpanRow = {
    evaluationId: "eval-1",
    documentId: "hashA",
    parentElementOrder: 4,
    rowIndex: 1,
    columnIndex: 2,
    cellText: "$1,500.50",
    value: "1500.5000",
    currency: "AUD",
    ...over,
  };
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
  it("reads a document's table-cell spans back with the value exact (no float drift)", async () => {
    // A header-evidenced bare-number column — the ~98.7% case redline is blind to
    // today: the cell text is a plain number, its money-ness and currency came
    // from the column header, and womblex resolved the amount and AUD for it.
    await seedSpan({ id: "s1", cellText: "1500.50", value: "1500.5000", currency: "AUD" });
    await seedSpan({
      id: "s2",
      rowIndex: 2,
      cellText: "980.00",
      value: "980.0000",
      currency: "AUD",
    });

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(2);
    const [first] = result.data;
    // Exact decimal string, not a rounded float — the whole reason the column is
    // numeric(38,4). "1500.5000" must not come back as 1500.5 or "1500.5".
    expect(first!.value).toBe("1500.5000");
    expect(first!.currency).toBe("AUD");
    expect(first!.locus).toBe("table_cell");
    expect(result.data.map((row) => row.value)).toEqual(["1500.5000", "980.0000"]);
  });

  it("orders a document's spans by (parentElementOrder, row, col) deterministically", async () => {
    await seedSpan({ id: "s-late", parentElementOrder: 9, rowIndex: 0, columnIndex: 0, value: "3.0000" });
    await seedSpan({ id: "s-early", parentElementOrder: 4, rowIndex: 0, columnIndex: 0, value: "1.0000" });
    await seedSpan({ id: "s-mid", parentElementOrder: 4, rowIndex: 1, columnIndex: 0, value: "2.0000" });

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.value)).toEqual(["1.0000", "2.0000", "3.0000"]);
  });

  it("addresses spans structurally by (document, table element)", async () => {
    await seedSpan({ id: "a1", parentElementOrder: 4, value: "10.0000" });
    await seedSpan({ id: "a2", parentElementOrder: 4, rowIndex: 5, value: "20.0000" });
    await seedSpan({ id: "b1", parentElementOrder: 9, value: "99.0000" });

    const result = await store.fetchByStructure("eval-1", {
      documentId: "hashA",
      parentElementOrder: 4,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(2);
    expect(result.data.map((row) => row.value).sort()).toEqual(["10.0000", "20.0000"]);
  });

  it("filters structurally by currency", async () => {
    await seedSpan({ id: "aud", value: "10.0000", currency: "AUD" });
    await seedSpan({ id: "usd", rowIndex: 3, value: "20.0000", currency: "USD" });

    const result = await store.fetchByStructure("eval-1", { currency: "USD" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.value).toBe("20.0000");
  });

  it("keeps a money-marked span whose currency is unresolved (null currency)", async () => {
    await seedSpan({ id: "n1", value: "12.3400", currency: null });

    const result = await store.fetchByDocument("eval-1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.currency).toBeNull();
  });

  it("scopes spans by evaluation", async () => {
    await seedEvaluation("eval-2");
    await seedSpan({ id: "e1", evaluationId: "eval-1", value: "1.0000" });
    await seedSpan({ id: "e2", evaluationId: "eval-2", value: "2.0000" });

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
  it("applies the migration a second time without error", async () => {
    await expect(applyMigrations((sql) => pg.exec(sql))).resolves.toBeUndefined();
    await seedSpan({ id: "after", value: "5.0000" });
    const result = await store.fetchByDocument("eval-1", "hashA");
    expect(isOk(result)).toBe(true);
  });
});
