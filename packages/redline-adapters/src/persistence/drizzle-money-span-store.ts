// DrizzleMoneySpanStore — the money-span query surface (ADR-0017/0018) over the
// redline_ schema. Implements IMoneySpanStore, so every method returns a Result
// and no driver exception crosses the port. Read-only: the sidecar's money stage
// writes `redline_money_spans` from `*.money_spans.parquet`
// (`womblex_ingest/money_span_store_postgres.py`, driven from `money_stage.py`);
// this adapter only queries it.
//
// It carries no requirement alignment, no currency conversion and no roll-up — a
// span is an addressable financial expression, and attaching it to a requirement is
// the report-assembler LLM's job over the graph (ADR-0017). The db handle is
// injected as a drizzle instance; the concrete
// driver (postgres-js in production, PGlite in tests) is the caller's choice.

import {
  domainError,
  err,
  ok,
  type IMoneySpanStore,
  type MoneySpanFilter,
  type MoneySpanLocus,
  type MoneySpanRow,
  type Result,
} from "@redline/redline-domain";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { redlineMoneySpans, type MoneySpanRow as MoneySpanTableRow } from "./schema";

// The minimal drizzle surface the store uses. Kept structural so both the
// postgres-js and PGlite drizzle instances satisfy it without a driver import.
interface RedlineDb {
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => {
        orderBy: (...columns: unknown[]) => Promise<unknown[]>;
      };
    };
  };
}

// A total order across all three loci. Each locus leaves most of these columns
// null, so `locus` leads: without it the null anchors interleave and two reads of
// the same rows can disagree. `id` is the final tiebreak because no anchor is
// unique — womblex scans a single cell for several self-evidencing amounts, and a
// range writes two rows sharing one anchor.
const STABLE_ORDER = [
  asc(redlineMoneySpans.documentId),
  asc(redlineMoneySpans.locus),
  asc(redlineMoneySpans.parentElementOrder),
  asc(redlineMoneySpans.sheet),
  asc(redlineMoneySpans.startChar),
  asc(redlineMoneySpans.rowIndex),
  asc(redlineMoneySpans.columnIndex),
  asc(redlineMoneySpans.id),
];

// Map a storage row into the domain shape — womblex's own columns, uninterpreted.
// `value` is left as the exact decimal string the numeric column round-trips
// (never coerced to a Number — that would reintroduce the float drift the
// numeric(38,4) column exists to avoid).
const toMoneySpanRow = (row: MoneySpanTableRow): MoneySpanRow => ({
  documentId: row.documentId,
  locus: row.locus as MoneySpanLocus,
  textSource: row.textSource,
  startChar: row.startChar,
  endChar: row.endChar,
  page: row.page,
  elementOrder: row.elementOrder,
  parentElementOrder: row.parentElementOrder,
  sheet: row.sheet,
  rowIndex: row.rowIndex,
  columnIndex: row.columnIndex,
  text: row.text,
  value: row.value,
  currency: row.currency,
  currencySource: row.currencySource,
  evidence: row.evidence,
  modifier: row.modifier,
  multiplier: row.multiplier,
  negative: row.negative,
  confidence: row.confidence,
  rangeGroup: row.rangeGroup,
  rangeRole: row.rangeRole,
  columnId: row.columnId,
  context: row.context,
});

export class DrizzleMoneySpanStore implements IMoneySpanStore {
  private readonly db: RedlineDb;

  constructor(database: unknown) {
    this.db = database as RedlineDb;
  }

  async fetchByDocument(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    return this.query(
      and(
        eq(redlineMoneySpans.evaluationId, evaluationId),
        eq(redlineMoneySpans.documentId, documentId),
      ),
      "failed to read money spans for document",
    );
  }

  async fetchByStructure(
    evaluationId: string,
    filter: MoneySpanFilter,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    const predicates: SQL[] = [eq(redlineMoneySpans.evaluationId, evaluationId)];
    if (filter.documentId !== undefined) {
      predicates.push(eq(redlineMoneySpans.documentId, filter.documentId));
    }
    if (filter.locus !== undefined) {
      predicates.push(eq(redlineMoneySpans.locus, filter.locus));
    }
    if (filter.parentElementOrder !== undefined) {
      predicates.push(eq(redlineMoneySpans.parentElementOrder, filter.parentElementOrder));
    }
    if (filter.currency !== undefined) {
      predicates.push(eq(redlineMoneySpans.currency, filter.currency));
    }
    return this.query(and(...predicates), "failed to read money spans by structure");
  }

  private async query(
    predicate: unknown,
    failureMessage: string,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    try {
      const rows = (await this.db
        .select()
        .from(redlineMoneySpans)
        .where(predicate)
        .orderBy(...STABLE_ORDER)) as MoneySpanTableRow[];
      return ok(rows.map(toMoneySpanRow));
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", failureMessage, cause));
    }
  }
}
