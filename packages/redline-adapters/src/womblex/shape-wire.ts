// The wire shape served by the womblex-ingest sidecar's shape routes
// (`GET /runs/{corpus}/shape`, `GET /runs/{corpus}/{run}/shape`). This is where
// an untrusted body is narrowed into a typed `CorpusShape`, so the reader itself
// stays a thin fetch. Kept internal to the adapter (not re-exported).
//
// Unlike the shard wire beside it, this body is validated in full: every field
// here is derived — a count, a tally, a bound — so there is no verbatim payload
// to leave untouched, and a malformed count is a wrong answer rather than an
// unrecognised one.

import {
  domainError,
  type AssetShape,
  type CorpusShape,
  type DomainError,
  type Result,
  type RunShape,
  type ShapeRange,
  type ShapeTally,
  type ShardColumn,
  err,
  ok,
} from "@redline/redline-domain";
import { isColumn, isRecord } from "./wire";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isTally = (value: unknown): value is ShapeTally =>
  isRecord(value) &&
  Array.isArray(value.counts) &&
  value.counts.every(
    (entry) => isRecord(entry) && "value" in entry && isCount(entry.rows),
  ) &&
  isCount(value.distinct) &&
  typeof value.truncated === "boolean";

const isRange = (value: unknown): value is ShapeRange =>
  isRecord(value) && "min" in value && "max" in value;

const recordOf = <T>(
  value: unknown,
  guard: (entry: unknown) => entry is T,
): Readonly<Record<string, T>> | null => {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, entry]) => guard(entry))
    ? (Object.fromEntries(entries) as Record<string, T>)
    : null;
};

const parseAsset = (value: unknown): AssetShape | null => {
  if (!isRecord(value)) return null;
  if (typeof value.name !== "string") return null;
  if (typeof value.present !== "boolean" || typeof value.readable !== "boolean") return null;
  // `null` is the honest answer for an asset redline refuses to serve, and is not
  // the same as nought rows.
  if (value.rows !== null && !isCount(value.rows)) return null;
  if (!Array.isArray(value.columns) || !value.columns.every(isColumn)) return null;

  const values = recordOf(value.values, isTally);
  const ranges = recordOf(value.ranges, isRange);
  if (values === null || ranges === null) return null;

  return {
    name: value.name,
    present: value.present,
    readable: value.readable,
    rows: value.rows,
    columns: value.columns as readonly ShardColumn[],
    values,
    ranges,
  };
};

const parseRun = (value: unknown): RunShape | null => {
  if (!isRecord(value)) return null;
  if (typeof value.runId !== "string" || typeof value.versioned !== "boolean") return null;
  if (!isCount(value.documents) || !Array.isArray(value.assets)) return null;

  const assets = value.assets.map(parseAsset);
  if (assets.some((asset) => asset === null)) return null;

  return {
    runId: value.runId,
    versioned: value.versioned,
    documents: value.documents,
    assets: assets as AssetShape[],
  };
};

// Narrow an untrusted JSON body into a CorpusShape, or an EXTRACTION_FAILED
// DomainError naming the first structural violation.
export const parseCorpusShape = (body: unknown): Result<CorpusShape, DomainError> => {
  if (!isRecord(body) || typeof body.corpusId !== "string") {
    return err(domainError("EXTRACTION_FAILED", "corpus shape missing corpusId"));
  }
  if (
    (body.runId !== null && typeof body.runId !== "string") ||
    (body.documentId !== null && typeof body.documentId !== "string")
  ) {
    return err(domainError("EXTRACTION_FAILED", "corpus shape has a malformed scope"));
  }
  if ((body.documents !== null && !isCount(body.documents)) || !Array.isArray(body.runs)) {
    return err(domainError("EXTRACTION_FAILED", "corpus shape has malformed run counts"));
  }

  const runs = body.runs.map(parseRun);
  if (runs.some((run) => run === null)) {
    return err(domainError("EXTRACTION_FAILED", "corpus shape has a malformed run"));
  }

  return ok({
    corpusId: body.corpusId,
    runId: body.runId,
    documentId: body.documentId,
    documents: body.documents,
    runs: runs as RunShape[],
  });
};
