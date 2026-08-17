import type { Result } from "../result";

// Reads money spans from a womblex run (MONEY_SPANS_SCHEMA). §5: financial
// constraints prefer a money span over parsing a string — its value is exact
// decimal128(38,4) with sign and multiplier already folded in. Trimmed to
// what the constraint normaliser and evidence-anchor matching need; the
// column-classification audit fields (evidence marker, multiplier,
// confidence, context, column_id) stay in the shard, not the port.

export type MoneySpanLocus = "narrative" | "table_cell" | "sheet_cell";
export type MoneySpanRangeRole = "lower" | "upper";

export interface MoneySpanAnchor {
  readonly locus: MoneySpanLocus;
  readonly startChar: number | null; // narrative locus
  readonly endChar: number | null;
  readonly page: number | null;
  readonly parentElemOrder: number | null; // table_cell locus
  readonly sheet: string | null; // sheet_cell locus
  readonly row: number | null;
  readonly col: number | null;
}

export interface MoneySpan {
  readonly documentId: string;
  readonly anchor: MoneySpanAnchor; // exactly one anchor group is non-null, per locus
  readonly text: string; // original, never lost
  readonly value: string; // decimal128(38,4) as a decimal string — never re-apply sign/multiplier
  readonly currency: string | null; // nullable — money-marked, currency unresolved
  readonly currencySource: string | null;
  readonly modifier: string | null; // "approximately" | "up to" | … — never folded into value
  readonly negative: boolean;
  readonly rangeGroup: number | null; // links a range's two endpoints
  readonly rangeRole: MoneySpanRangeRole | null;
}

export interface IMoneySpanStore {
  readMoneySpans(corpusId: string, runId: string, documentId: string): Promise<Result<readonly MoneySpan[]>>;
}
