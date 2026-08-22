// The wire shape served by the womblex-ingest sidecar's run-scoped shard route
// (`GET /runs/{corpus}/{run}/shards/{asset}`). This is the one place that trusts
// the wire and narrows `unknown` into a typed `ShardPage`, so the reader itself
// stays a thin fetch. Kept internal to the adapter (not re-exported).
//
// Rows are validated as *objects*, not against a fixed schema: the whole point of
// this seam is that it serves whatever columns womblex wrote, verbatim. Asserting
// a column set here would reintroduce the coupling the seam exists to remove.

import {
  domainError,
  type DomainError,
  type Result,
  type ShardColumn,
  type ShardPage,
  type ShardRow,
  err,
  ok,
} from "@redline/redline-domain";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isColumn = (value: unknown): value is ShardColumn =>
  isRecord(value) && typeof value.name === "string" && typeof value.type === "string";

const isRow = (value: unknown): value is ShardRow => isRecord(value);

const everyIsArrayOf = <T>(value: unknown, guard: (v: unknown) => v is T): value is T[] =>
  Array.isArray(value) && value.every(guard);

// Narrow an untrusted JSON body into a ShardPage, or an EXTRACTION_FAILED
// DomainError describing the first structural violation. Row *contents* are trusted
// verbatim; only the page envelope is checked.
export const parseShardPage = (body: unknown): Result<ShardPage, DomainError> => {
  if (!isRecord(body)) {
    return err(domainError("EXTRACTION_FAILED", "shard page is not an object"));
  }
  if (typeof body.asset !== "string" || typeof body.runId !== "string") {
    return err(domainError("EXTRACTION_FAILED", "shard page missing asset/runId"));
  }
  if (!everyIsArrayOf(body.columns, isColumn)) {
    return err(domainError("EXTRACTION_FAILED", "shard page has malformed columns"));
  }
  if (!everyIsArrayOf(body.rows, isRow)) {
    return err(domainError("EXTRACTION_FAILED", "shard page has malformed rows"));
  }
  if (
    !isNumber(body.returned) ||
    !isNumber(body.available) ||
    typeof body.truncated !== "boolean"
  ) {
    return err(domainError("EXTRACTION_FAILED", "shard page has malformed paging counts"));
  }
  return ok({
    asset: body.asset,
    runId: body.runId,
    columns: body.columns,
    rows: body.rows,
    returned: body.returned,
    available: body.available,
    truncated: body.truncated,
  });
};

// Best-effort read of the sidecar's Result-shaped error body for a non-2xx
// response; falls back to the HTTP status when the body is not shaped as expected.
export const parseErrorBody = (status: number, body: unknown): DomainError => {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    const code = typeof body.error.code === "string" ? body.error.code : "INFRA_FAILURE";
    // The sidecar's NOT_FOUND maps straight through; anything else at the read
    // seam is an infrastructure/extraction failure from the domain's point of view.
    const mapped = code === "NOT_FOUND" ? "NOT_FOUND" : "EXTRACTION_FAILED";
    return domainError(mapped, body.error.message);
  }
  return domainError("INFRA_FAILURE", `womblex-ingest returned HTTP ${status}`);
};
