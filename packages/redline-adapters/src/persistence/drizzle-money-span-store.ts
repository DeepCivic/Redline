// DrizzleMoneySpanStore — the money-span query surface (ADR-0017/0018) over the
// redline_ schema. Implements IMoneySpanStore, so every method returns a Result
// and no driver exception crosses the port. Read-only: the sidecar's ingest load
// path (the one reader of womblex's Parquet schema) writes `redline_money_spans`
// from `*.money_spans.parquet`; this adapter only queries it.
//
// It carries no requirement alignment — a span is an addressable pricing fact,
// and attaching it to a requirement is the report-assembler LLM's job over the
// graph (ADR-0017). The db handle is injected as a drizzle instance; the concrete
// driver (postgres-js in production, PGlite in tests) is the caller's choice.

import {
  domainError,
  err,
  ok,
  type IMoneySpanStore,
  type MoneySpanFilter,
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

const STABLE_ORDER = [
  asc(redlineMoneySpans.documentId),
  asc(redlineMoneySpans.parentElementOrder),
  asc(redlineMoneySpans.rowIndex),
  asc(redlineMoneySpans.columnIndex),
];

// Map a storage row into the domain shape. `value` is left as the exact decimal
// string the numeric column round-trips (never coerced to a Number — that would
// reintroduce the float drift the numeric(38,4) column exists to avoid).
const toMoneySpanRow = (row: MoneySpanTableRow): MoneySpanRow => ({
  documentId: row.documentId,
  locus: "table_cell",
  parentElementOrder: row.parentElementOrder,
  rowIndex: row.rowIndex,
  columnIndex: row.columnIndex,
  text: row.cellText,
  value: row.value,
  currency: row.currency,
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
