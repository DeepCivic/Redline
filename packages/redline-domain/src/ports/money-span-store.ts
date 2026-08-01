import type { Result } from "../result";

// The money-span query surface (ADR-0017/0018), TypeScript side. redline recovers
// tender pricing from womblex's offline `money` op, which writes one row per
// amount into `*.money_spans.parquet` — column-evidenced (a bare number whose
// money-ness comes from its header, ~98.7% of amounts) as well as self-evidencing,
// each with an exact `Decimal` and a resolved currency. That Parquet is bulk,
// corpus-scaled columnar data, so it is materialised into redline's `redline_`
// store and queried in place, never parsed in TypeScript (ADR-0017) — this port is
// the domain's view of that store, plain data by construction so `redline-domain`
// purity (validate.sh #4) keeps it Parquet/Arrow-free.
//
// This surface deliberately carries NO requirementId and does no alignment. A span
// is an addressable, provenance-tagged fact — "this cell holds this amount in this
// currency". Attaching a span to a requirement is the report-assembler LLM's job,
// traversing the graph and calling tools to locate the right source rows (ADR-0017);
// this port only makes the spans addressable for those tools. It is a sibling of
// `IChunkStore`: the same exact / structural addressing, over money instead of text.

// One `locus='table_cell'` money span, keyed on the womblex provenance it was
// annotated against: `(source_hash, parent_elem_order, row, col)` on the
// `*.table_cells.parquet` sidecar. Only the table-cell locus is modelled — that is
// the tender pricing shape redline reads (the narrative and sheet-cell loci womblex
// also writes are out of scope here). `value` is the exact amount as a decimal
// STRING (womblex's `decimal128(38,4)`), never a float: aggregating amounts
// accumulates float error and reconciliation compares for equality, so the
// exactness must survive the seam. `currency` is nullable — a span can be
// money-marked with its currency unresolved.
export interface MoneySpanRow {
  readonly documentId: string; // womblex source_hash
  readonly locus: "table_cell";
  readonly parentElementOrder: number; // womblex parent_elem_order — the table element
  readonly rowIndex: number; // womblex row
  readonly columnIndex: number; // womblex col
  readonly text: string; // the original cell text — never lost
  readonly value: string; // exact Decimal as a string, e.g. "1500.5000"
  readonly currency: string | null; // ISO code, or null when unresolved
}

// A structural predicate over the money spans. Every field is optional; a set
// field narrows the result, an unset one is ignored. The addressing half —
// document / table element / currency — not a similarity query. Mirrors
// `IChunkStore`'s `StructureFilter`.
export interface MoneySpanFilter {
  readonly documentId?: string;
  readonly parentElementOrder?: number;
  readonly currency?: string;
}

export interface IMoneySpanStore {
  // Every table-cell money span for a document, ordered by
  // (parentElementOrder, rowIndex, columnIndex) so the result is stable — the
  // whole-document read a report tool starts from.
  fetchByDocument(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly MoneySpanRow[]>>;

  // Structural addressing — the spans matching every set field of `filter`,
  // ordered by (documentId, parentElementOrder, rowIndex, columnIndex).
  fetchByStructure(
    evaluationId: string,
    filter: MoneySpanFilter,
  ): Promise<Result<readonly MoneySpanRow[]>>;
}
