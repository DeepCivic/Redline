import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type { IMoneySpanStore, MoneySpan } from "./money-span-store";

// Fake shaped against the 0c sample's real money_spans.parquet rows — the two
// statutory-penalty amounts, both narrative locus.
const DOCUMENT_ID = "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54";

class StubMoneySpanStore implements IMoneySpanStore {
  async readMoneySpans(): Promise<Result<readonly MoneySpan[]>> {
    return ok([
      {
        documentId: DOCUMENT_ID,
        anchor: { locus: "narrative", startChar: 2605, endChar: 2612, page: 1, parentElemOrder: null, sheet: null, row: null, col: null },
        text: "$10 000",
        value: "10000.0000",
        currency: "AUD",
        currencySource: "symbol",
        modifier: null,
        negative: false,
        rangeGroup: null,
        rangeRole: null,
      },
    ]);
  }
}

describe("port conformance (in-memory fake)", () => {
  it("reads a run-scoped document's money spans, value exact and unfolded", async () => {
    const store: IMoneySpanStore = new StubMoneySpanStore();

    const result = await store.readMoneySpans("corpus-1", "run-1", DOCUMENT_ID);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]?.value).toBe("10000.0000");
    expect(result.data[0]?.anchor.locus).toBe("narrative");
  });
});
