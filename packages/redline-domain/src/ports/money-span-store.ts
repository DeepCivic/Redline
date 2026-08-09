import type { Result } from "../result";

// The money-span query surface (ADR-0017/0018), TypeScript side. redline recovers
// tender financials from womblex's offline `money` op, which writes one row per
// amount into `*.money_spans.parquet` — column-evidenced (a bare number whose
// money-ness comes from its header, ~98.7% of amounts) as well as self-evidencing,
// each with an exact `Decimal` and a resolved currency. That Parquet is bulk,
// corpus-scaled columnar data, so it is materialised into redline's `redline_`
// store and queried in place, never parsed in TypeScript (ADR-0017) — this port is
// the domain's view of that store, plain data by construction so `redline-domain`
// purity (validate.sh #4) keeps it Parquet/Arrow-free.
//
// These are *financial expressions*, not prices. A price is one reading of one of
// them, and the reading belongs above this seam: the row below is womblex's own
// span copied across, uninterpreted. This surface deliberately carries NO
// requirementId and does no alignment, no currency conversion and no roll-up.
//
// Attaching a span to a requirement therefore happens *above* this port — and this
// port names no single owner of it, because there is more than one. There are two
// consumers with two legitimate readings of the same rows: the review grid's
// `MoneySpanFinancialExtractor`, which attributes a document's money to its
// highest-confidence classification deterministically, and the report-assembler LLM,
// which reaches these rows through the MCP report tool surface and aligns them
// itself. This comment previously assigned the job to the assembler alone while the
// extractor was already doing it; the extractor owns the grid's reading, the
// assembler owns the report's, and neither is this port's business. It is a sibling
// of `IChunkStore`: the same exact / structural addressing, over money instead of text.

// womblex writes three loci into one file and discriminates them with this column.
// Narrative is where prose amounts live — "the total contract value is $2.4
// million" — and tenders arrive predominantly as PDFs, so it carries a large share
// of the money in a corpus.
export type MoneySpanLocus = "narrative" | "table_cell" | "sheet_cell";

// One money span, as womblex wrote it: `MONEY_SPANS_SCHEMA`
// (`services/womblex/src/womblex/store/money_output.py` @ v0.3.0) with
// `source_hash` renamed to `documentId` and the columns camel-cased. Nothing is
// interpreted, converted or dropped on the way in.
//
// **Exactly one anchor group is non-null per row** — womblex's own invariant,
// discriminated by `locus`:
//   narrative   — startChar / endChar (+ page), character offsets into the
//                 reassembled narrative in the layer `textSource` names, the same
//                 coordinate space enrichment mentions use;
//   table_cell  — parentElementOrder / rowIndex / columnIndex on the
//                 `*.table_cells.parquet` sidecar;
//   sheet_cell  — sheet / rowIndex / columnIndex (+ elementOrder).
//
// `value` is the exact amount as a decimal STRING (womblex's `decimal128(38,4)`),
// never a float: aggregating amounts accumulates float error and reconciliation
// compares for equality, so the exactness must survive the seam. It arrives with
// the magnitude suffix and the sign already applied, which makes `multiplier` and
// `negative` an audit trail rather than arithmetic to redo. `modifier`
// ("approximately", "up to") is the one qualifier womblex refuses to fold in, so a
// consumer that ignores it reads "up to $2M" as exactly $2M. `currency` is nullable
// — a span can be money-marked with its currency unresolved.
export interface MoneySpanRow {
  readonly documentId: string; // womblex source_hash
  readonly locus: MoneySpanLocus;
  readonly textSource: string | null; // elements | normalised | spellfix (narrative)
  readonly startChar: number | null;
  readonly endChar: number | null;
  readonly page: number | null;
  readonly elementOrder: number | null; // sheet_cell anchor
  readonly parentElementOrder: number | null; // table_cell anchor — the table element
  readonly sheet: string | null;
  readonly rowIndex: number | null;
  readonly columnIndex: number | null;
  readonly text: string; // the original text — never lost
  readonly value: string; // exact Decimal as a string, e.g. "1500.5000"
  readonly currency: string | null; // ISO code, or null when unresolved
  readonly currencySource: string | null; // symbol|iso|word|number_format|column_header|document_default
  readonly evidence: string | null; // p1..p10 | number_format | header+numeric | header_currency
  readonly modifier: string | null; // approximately | up to | … — never folded into value
  readonly multiplier: string | null; // thousand | million | billion | trillion | cents
  readonly negative: boolean;
  readonly confidence: number;
  readonly rangeGroup: number | null; // links a range's two endpoints
  readonly rangeRole: string | null; // lower | upper
  readonly columnId: string | null; // the classified column a cell inherited
  readonly context: string | null;
}

// A structural predicate over the money spans. Every field is optional; a set
// field narrows the result, an unset one is ignored. The addressing half —
// document / locus / table element / currency — not a similarity query. Mirrors
// `IChunkStore`'s `StructureFilter`. `parentElementOrder` only ever matches
// table-cell spans, since it is the anchor that locus alone carries.
export interface MoneySpanFilter {
  readonly documentId?: string;
  readonly locus?: MoneySpanLocus;
  readonly parentElementOrder?: number;
  readonly currency?: string;
}

export interface IMoneySpanStore {
  // Every money span for a document, across all three loci, in a stable order —
  // the whole-document read a report tool starts from.
  fetchByDocument(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly MoneySpanRow[]>>;

  // Structural addressing — the spans matching every set field of `filter`, in the
  // same stable order.
  fetchByStructure(
    evaluationId: string,
    filter: MoneySpanFilter,
  ): Promise<Result<readonly MoneySpanRow[]>>;
}
