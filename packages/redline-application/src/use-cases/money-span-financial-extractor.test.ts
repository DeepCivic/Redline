import { describe, it, expect } from "vitest";
import { ok, err, domainError, isOk, isErr, type Result } from "@redline/redline-domain";
import type {
  FinancialExtractionRequest,
  IMoneySpanStore,
  MoneySpanFilter,
  MoneySpanRow,
} from "@redline/redline-domain";
import { MoneySpanFinancialExtractor } from "./money-span-financial-extractor";

// The real IFinancialExtractor: it turns womblex's addressable money spans into
// the (documentId, requirementId) costing the review grid needs. The spans carry
// no requirement — attribution is this extractor's job, and the rule is:
//   a document's spans attach to the ONE requirement its classification matched
//   with the highest confidence (ties → lexicographically-least requirementId).
// A document's money lands once on that single row, so the per-brand pivot totals it
// without double-counting a document that matched >1 requirement.
//
// What each span contributes is readDocumentMoney's reading (money-span-reading.ts),
// which is specified by its own suite. The cases here are the port-level proof that
// the grid gets that reading and not a straight sum.

const span = (over: Partial<MoneySpanRow> = {}): MoneySpanRow => ({
  documentId: "doc-a",
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
  currencySource: "symbol",
  evidence: "p1",
  modifier: null,
  multiplier: null,
  negative: false,
  confidence: 0.9,
  rangeGroup: null,
  rangeRole: null,
  columnId: null,
  context: null,
  ...over,
});

class InMemoryMoneySpanStore implements IMoneySpanStore {
  constructor(private readonly rows: readonly MoneySpanRow[]) {}

  async fetchByDocument(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    void evaluationId;
    return ok(this.rows.filter((row) => row.documentId === documentId));
  }

  async fetchByStructure(
    evaluationId: string,
    filter: MoneySpanFilter,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    void evaluationId;
    return ok(
      this.rows.filter(
        (row) => filter.documentId === undefined || row.documentId === filter.documentId,
      ),
    );
  }
}

class FailingMoneySpanStore implements IMoneySpanStore {
  async fetchByDocument(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    void evaluationId;
    void documentId;
    return err(domainError("INFRA_FAILURE", "store unreachable"));
  }

  async fetchByStructure(
    evaluationId: string,
    filter: MoneySpanFilter,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    void evaluationId;
    void filter;
    return err(domainError("INFRA_FAILURE", "store unreachable"));
  }
}

const request = (over: Partial<FinancialExtractionRequest> = {}): FinancialExtractionRequest => ({
  evaluationId: "eval-1",
  responseGroupId: "g-acme",
  documentIds: ["doc-a"],
  matchedRequirements: [{ documentId: "doc-a", requirementId: "req-price", confidence: 0.86 }],
  ...over,
});

describe("MoneySpanFinancialExtractor — real AUD from the money spans", () => {
  it("sums a document's priced rows into one AUD figure on its matched requirement", async () => {
    const store = new InMemoryMoneySpanStore([
      span({ rowIndex: 1, value: "1000.0000" }),
      span({ rowIndex: 2, value: "500.5000" }),
    ]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    const [row] = result.data;
    expect(row!.documentId).toBe("doc-a");
    expect(row!.requirementId).toBe("req-price");
    expect(row!.estimateAud).toBe(1500.5);
  });

  it("sums exactly — no float drift across many amounts", async () => {
    // 0.1 + 0.2 in IEEE float is 0.30000000000000004; fixed-point stays exact.
    const store = new InMemoryMoneySpanStore([
      span({ rowIndex: 1, value: "0.1000" }),
      span({ rowIndex: 2, value: "0.2000" }),
    ]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.estimateAud).toBe(0.3);
  });

  it("attributes to the highest-confidence requirement when a doc matched several", async () => {
    const store = new InMemoryMoneySpanStore([span({ value: "2500.0000" })]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(
      request({
        matchedRequirements: [
          { documentId: "doc-a", requirementId: "req-support", confidence: 0.4 },
          { documentId: "doc-a", requirementId: "req-price", confidence: 0.9 },
        ],
      }),
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // One row only — the money lands on the best match, never duplicated.
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.requirementId).toBe("req-price");
    expect(result.data[0]!.estimateAud).toBe(2500);
  });

  it("breaks a confidence tie on the lexicographically-least requirementId", async () => {
    const store = new InMemoryMoneySpanStore([span({ value: "100.0000" })]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(
      request({
        matchedRequirements: [
          { documentId: "doc-a", requirementId: "req-zeta", confidence: 0.7 },
          { documentId: "doc-a", requirementId: "req-alpha", confidence: 0.7 },
        ],
      }),
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.requirementId).toBe("req-alpha");
  });

  it("recovers the header-evidenced bare-number column (currency on the span, plain text)", async () => {
    // The 98.7% case: a cell whose text is a bare number, money-marked because its
    // column header said so. The currency rides on the span; the extractor totals it.
    const store = new InMemoryMoneySpanStore([
      span({ rowIndex: 1, text: "1200", value: "1200.0000", currency: "AUD" }),
      span({ rowIndex: 2, text: "800", value: "800.0000", currency: "AUD" }),
    ]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.estimateAud).toBe(2000);
    expect(result.data[0]!.description).toContain("2 priced");
  });

  it("emits no row for a document with spans but no matched requirement", async () => {
    const store = new InMemoryMoneySpanStore([span({ value: "999.0000" })]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request({ matchedRequirements: [] }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(0);
  });

  it("emits no row for a matched document with no spans (nothing priced)", async () => {
    const store = new InMemoryMoneySpanStore([]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(0);
  });

  it("keeps documents separate — each sums its own spans onto its own match", async () => {
    const store = new InMemoryMoneySpanStore([
      span({ documentId: "doc-a", value: "1000.0000" }),
      span({ documentId: "doc-b", value: "2000.0000" }),
    ]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(
      request({
        documentIds: ["doc-a", "doc-b"],
        matchedRequirements: [
          { documentId: "doc-a", requirementId: "req-price", confidence: 0.8 },
          { documentId: "doc-b", requirementId: "req-price", confidence: 0.8 },
        ],
      }),
    );

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(2);
    const byDoc = new Map(result.data.map((row) => [row.documentId, row.estimateAud]));
    expect(byDoc.get("doc-a")).toBe(1000);
    expect(byDoc.get("doc-b")).toBe(2000);
  });

  it("carries the span's provenance element order onto the extraction", async () => {
    const store = new InMemoryMoneySpanStore([span({ parentElementOrder: 12, value: "50.0000" })]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.elementOrder).toBe(12);
  });

  it("counts each amount once for a document carrying a range, a modifier and a prose total", async () => {
    // The exit case, at the port: the grid figure is asserted against the spans that
    // should count, never against a total written into the fixture.
    const pricedCells = [
      span({ rowIndex: 1, value: "1200.0000" }),
      span({ rowIndex: 2, value: "800.0000", modifier: "up to" }),
    ];
    const proseTotal = span({
      locus: "narrative",
      parentElementOrder: null,
      rowIndex: null,
      columnIndex: null,
      startChar: 10,
      text: "the total contract value is $2,000",
      value: "2000.0000",
    });
    const rangeLower = span({
      locus: "narrative",
      parentElementOrder: null,
      rowIndex: null,
      columnIndex: null,
      startChar: 90,
      value: "500.0000",
      rangeGroup: 1,
      rangeRole: "lower",
    });
    const rangeUpper = span({
      ...rangeLower,
      startChar: 99,
      value: "900.0000",
      rangeRole: "upper",
    });
    const store = new InMemoryMoneySpanStore([...pricedCells, proseTotal, rangeLower, rangeUpper]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const expected = pricedCells.reduce((sum, priced) => sum + Number(priced.value), 0);
    expect(result.data[0]!.estimateAud).toBe(expected);
    expect(result.data[0]!.description).toContain("1 amount is a ceiling");
  });

  it("counts a prose range once when the document prices only in prose", async () => {
    const lower = span({
      locus: "narrative",
      parentElementOrder: null,
      rowIndex: null,
      columnIndex: null,
      startChar: 10,
      value: "1000000.0000",
      rangeGroup: 1,
      rangeRole: "lower",
    });
    const upper = span({ ...lower, startChar: 24, value: "2000000.0000", rangeRole: "upper" });
    const store = new InMemoryMoneySpanStore([lower, upper]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.estimateAud).toBe(Number(upper.value));
  });

  it("anchors the extraction on a span the figure counted, not on an excluded one", async () => {
    // The prose total sorts first out of the store; anchoring on it would deep-link
    // the grid to money the figure deliberately leaves out.
    const proseTotal = span({
      locus: "narrative",
      parentElementOrder: null,
      elementOrder: 99,
      rowIndex: null,
      columnIndex: null,
      startChar: 10,
      value: "5000.0000",
    });
    const store = new InMemoryMoneySpanStore([
      proseTotal,
      span({ parentElementOrder: 7, value: "5000.0000" }),
    ]);
    const extractor = new MoneySpanFinancialExtractor({ moneySpanStore: store });

    const result = await extractor.extractFinancials(request());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]!.elementOrder).toBe(7);
  });

  it("propagates a store failure unchanged", async () => {
    const extractor = new MoneySpanFinancialExtractor({
      moneySpanStore: new FailingMoneySpanStore(),
    });

    const result = await extractor.extractFinancials(request());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });
});
