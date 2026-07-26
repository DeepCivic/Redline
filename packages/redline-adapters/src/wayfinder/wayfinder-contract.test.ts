import { describe, it, expect } from "vitest";
import {
  WAYFINDER_COUNT_PIVOT_CONTRACT,
  WAYFINDER_PIVOT_CONTRACT,
  WAYFINDER_TYPED_CELL_CONTRACT,
  WAYFINDER_TYPED_VALUE_CONTRACT,
  loadWayfinderDomain,
} from "./wayfinder-contract";

// --- The Wayfinder drift check (ADR-0012, superseding ADR-0001's spike) --------
//
// Every value redline reuses from `@rbrasier/domain` is frozen in
// wayfinder-contract.ts, and asserted against the *real* upstream helpers here.
// The frozen values are what the rest of the workspace tests against, so this
// file is the single place upstream drift can be caught.
//
// Wayfinder is an optional dependency: absent locally, this suite skips. CI
// vendors the pinned tree and sets REQUIRE_WAYFINDER=1, which turns absence into
// a loud failure rather than a silent skip.
const wayfinder = await loadWayfinderDomain();

describe.skipIf(wayfinder === null)("Wayfinder typed-cell contract", () => {
  it("still renders every frozen typedDisplayCell case identically", () => {
    for (const testCase of WAYFINDER_TYPED_CELL_CONTRACT) {
      expect(wayfinder!.typedDisplayCell(testCase.type, testCase.raw)).toEqual(testCase.cell);
    }
  });

  it("still unwraps every frozen typedCellValue case identically", () => {
    for (const testCase of WAYFINDER_TYPED_VALUE_CONTRACT) {
      expect(wayfinder!.typedCellValue(testCase.type, testCase.raw)).toBe(testCase.value);
    }
  });
});

describe.skipIf(wayfinder === null)("Wayfinder pivot contract", () => {
  it("still rolls the frozen rows up to the frozen totals", () => {
    const result = wayfinder!.computePivot(WAYFINDER_PIVOT_CONTRACT.rows, {
      columns: WAYFINDER_PIVOT_CONTRACT.columns,
      groupByKey: WAYFINDER_PIVOT_CONTRACT.groupByKey,
      measure: WAYFINDER_PIVOT_CONTRACT.measure,
    });

    expect(result.rows.map((row) => ({ key: row.key, value: row.total.value }))).toEqual(
      WAYFINDER_PIVOT_CONTRACT.expectedRows,
    );
    expect(result.grandTotal).toEqual(WAYFINDER_PIVOT_CONTRACT.expectedGrandTotal);
    expect(result.hasNumericData).toBe(true);
  });

  // The Document Map (Thread 25) reuses computePivot's *count* measure ranking —
  // descending count, alphabetical tiebreak — over redline's own types. Freeze
  // the order upstream produces so drift in the ranking rule surfaces here, the
  // one package that may reach Wayfinder.
  it("still ranks a count roll-up the way the Document Map depends on", () => {
    const result = wayfinder!.computePivot(WAYFINDER_COUNT_PIVOT_CONTRACT.rows, {
      columns: WAYFINDER_COUNT_PIVOT_CONTRACT.columns,
      groupByKey: WAYFINDER_COUNT_PIVOT_CONTRACT.groupByKey,
      measure: WAYFINDER_COUNT_PIVOT_CONTRACT.measure,
    });

    expect(result.rows.map((row) => ({ key: row.key, value: row.total.value }))).toEqual(
      WAYFINDER_COUNT_PIVOT_CONTRACT.expectedRows,
    );
    expect(result.grandTotal).toEqual(WAYFINDER_COUNT_PIVOT_CONTRACT.expectedGrandTotal);
    expect(result.hasNumericData).toBe(true);
  });
});

describe("loadWayfinderDomain", () => {
  it("reports whether the vendored tree is present, without throwing either way", () => {
    expect(wayfinder === null || typeof wayfinder.typedDisplayCell === "function").toBe(true);
  });

  it("fails loudly instead of skipping when REQUIRE_WAYFINDER is set", async () => {
    if (wayfinder !== null) return;

    const previous = process.env.REQUIRE_WAYFINDER;
    process.env.REQUIRE_WAYFINDER = "1";
    await expect(loadWayfinderDomain()).rejects.toThrow();
    process.env.REQUIRE_WAYFINDER = previous;
  });
});
