import type { ProcurementResponse } from "@redline/redline-domain";

// PricingPivot — the pricing roll-up brain (build plan §1 "Aggregate: pricing
// per brand (vendor); pricing per requirement/criterion", §7 Thread 13). A
// pure, framework-free model that rolls the Thread 10/12 ProcurementResponse[]
// up per brand, per requirement, or brand×requirement, summing or averaging the
// real-number estimateAud (Thread 8/10). It mirrors the algorithm of
// Wayfinder's computePivot (§9) — first-appearance distinct groups, ranked by
// descending measure total with an alphabetical tiebreak, sum/avg tracking the
// numeric sample count so a null estimate (the description-fallback signal)
// degrades gracefully — but over redline's own domain type, so production app
// code imports nothing from Wayfinder (the parity is pinned test-only, matching
// Thread 12's typedDisplayCell posture). The Excel export (Thread 14) writes one
// sheet per PricingPivotResult.

// The axes the plan names: pricing per brand, per requirement/criterion, and the
// brand × requirement cross-tab.
export const PIVOT_AXES = ["brand", "requirement", "brand-x-requirement"] as const;
export type PivotAxis = (typeof PIVOT_AXES)[number];

export type PivotMeasureKind = "sum" | "avg";

export interface PivotRequest {
  readonly axis: PivotAxis;
  readonly measure: PivotMeasureKind;
}

// `value` is the measure result (sum or average of estimateAud). `sampleCount`
// is the number of rows that carried a numeric figure — the average denominator
// and the signal for the "no figure yet" (description-fallback) rows.
export interface PivotCell {
  readonly value: number;
  readonly sampleCount: number;
}

export interface PivotRow {
  readonly key: string;
  // One cell per secondary group for a cross-tab; a single cell (== total)
  // otherwise, mirroring computePivot's row shape.
  readonly cells: readonly PivotCell[];
  readonly total: PivotCell;
}

export interface PricingPivotResult {
  readonly primaryGroups: readonly string[];
  readonly secondaryGroups: readonly string[] | null;
  readonly rows: readonly PivotRow[];
  readonly columnTotals: readonly PivotCell[];
  readonly grandTotal: PivotCell;
  readonly hasNumericData: boolean;
}

// The value each axis groups a response by. brand-x-requirement uses vendor as
// the primary axis and requirement as the secondary.
const primaryKeyFor = (axis: PivotAxis, response: ProcurementResponse): string =>
  axis === "requirement" ? response.requirementId : response.vendorName;

const secondaryKeyFor = (axis: PivotAxis, response: ProcurementResponse): string | null =>
  axis === "brand-x-requirement" ? response.requirementId : null;

// Sum/avg of the real-number estimateAud, counting only rows that carry a figure
// so a description-fallback row (estimateAud: null, Thread 10) never skews an
// average or masquerades as a zero.
const aggregate = (subset: readonly ProcurementResponse[], measure: PivotMeasureKind): PivotCell => {
  const figures: number[] = [];
  for (const response of subset) {
    const estimate = response.costing.estimateAud;
    if (estimate !== null && Number.isFinite(estimate)) figures.push(estimate);
  }

  const sum = figures.reduce((total, value) => total + value, 0);
  if (measure === "sum") return { value: sum, sampleCount: figures.length };
  return { value: figures.length === 0 ? 0 : sum / figures.length, sampleCount: figures.length };
};

// Distinct group values in first-appearance order (before ranking) — matches
// computePivot so the two engines agree.
const distinctKeys = (keys: readonly string[]): string[] => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
};

// Ranks group keys by descending measure total, breaking ties alphabetically so
// the table and any chart are deterministic (computePivot's rankByTotal).
const rankByTotal = (keys: readonly string[], totalByKey: Map<string, PivotCell>): string[] =>
  [...keys].sort((first, second) => {
    const difference = (totalByKey.get(second)?.value ?? 0) - (totalByKey.get(first)?.value ?? 0);
    if (difference !== 0) return difference;
    if (first < second) return -1;
    if (first > second) return 1;
    return 0;
  });

export class PricingPivot {
  private readonly responses: readonly ProcurementResponse[];

  constructor(responses: readonly ProcurementResponse[]) {
    this.responses = responses;
  }

  compute(request: PivotRequest): PricingPivotResult {
    const { axis, measure } = request;

    const grandTotal = aggregate(this.responses, measure);
    const hasNumericData = grandTotal.sampleCount > 0;

    const primaryTotals = new Map<string, PivotCell>();
    const primaryKeys = distinctKeys(this.responses.map((response) => primaryKeyFor(axis, response)));
    for (const key of primaryKeys) {
      const subset = this.responses.filter((response) => primaryKeyFor(axis, response) === key);
      primaryTotals.set(key, aggregate(subset, measure));
    }
    const primaryGroups = rankByTotal(primaryKeys, primaryTotals);

    if (axis !== "brand-x-requirement") {
      const rows: PivotRow[] = primaryGroups.map((key) => {
        const total = primaryTotals.get(key)!;
        return { key, cells: [total], total };
      });
      return {
        primaryGroups,
        secondaryGroups: null,
        rows,
        columnTotals: [grandTotal],
        grandTotal,
        hasNumericData,
      };
    }

    const secondaryTotals = new Map<string, PivotCell>();
    const secondaryKeys = distinctKeys(
      this.responses
        .map((response) => secondaryKeyFor(axis, response))
        .filter((key): key is string => key !== null),
    );
    for (const key of secondaryKeys) {
      const subset = this.responses.filter((response) => secondaryKeyFor(axis, response) === key);
      secondaryTotals.set(key, aggregate(subset, measure));
    }
    const secondaryGroups = rankByTotal(secondaryKeys, secondaryTotals);

    const rows: PivotRow[] = primaryGroups.map((primaryKey) => {
      const cells = secondaryGroups.map((secondaryKey) => {
        const subset = this.responses.filter(
          (response) =>
            primaryKeyFor(axis, response) === primaryKey &&
            secondaryKeyFor(axis, response) === secondaryKey,
        );
        return aggregate(subset, measure);
      });
      return { key: primaryKey, cells, total: primaryTotals.get(primaryKey)! };
    });

    return {
      primaryGroups,
      secondaryGroups,
      rows,
      columnTotals: secondaryGroups.map((key) => secondaryTotals.get(key)!),
      grandTotal,
      hasNumericData,
    };
  }
}
