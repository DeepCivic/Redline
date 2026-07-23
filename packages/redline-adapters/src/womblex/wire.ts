// The wire shape served by the womblex-ingest sidecar's Parquet→JSON read seam
// (`GET /extractions/{evaluationId}/{documentId}`). These interfaces mirror the
// sidecar's `records.py` dataclasses exactly; `parseDocumentExtraction` is the one
// place that trusts the wire and narrows `unknown` → typed provenance, so the reader
// itself stays a thin mapping. Kept internal to the adapter (not re-exported).

import { domainError, type DomainError, type Result, err, ok } from "@redline/redline-domain";

export interface WireElement {
  readonly documentId: string;
  readonly elementOrder: number;
  readonly page: number | null;
  readonly text: string;
}

export interface WireChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly text: string;
}

export interface WireTableCell {
  readonly documentId: string;
  readonly elementOrder: number;
  readonly page: number | null;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rawValue: string;
  readonly isCurrency: boolean;
}

export interface WireDocumentExtraction {
  readonly documentId: string;
  readonly elements: readonly WireElement[];
  readonly chunks: readonly WireChunk[];
  readonly tableCells: readonly WireTableCell[];
}

// Result-shaped error body the sidecar emits ({"error": {"code","message"}}).
export interface WireErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPageValue = (value: unknown): value is number | null =>
  value === null || isNumber(value);

const isElement = (value: unknown): value is WireElement =>
  isRecord(value) &&
  typeof value.documentId === "string" &&
  isNumber(value.elementOrder) &&
  isPageValue(value.page) &&
  typeof value.text === "string";

const isChunk = (value: unknown): value is WireChunk =>
  isRecord(value) &&
  typeof value.chunkId === "string" &&
  typeof value.documentId === "string" &&
  typeof value.text === "string";

const isTableCell = (value: unknown): value is WireTableCell =>
  isRecord(value) &&
  typeof value.documentId === "string" &&
  isNumber(value.elementOrder) &&
  isPageValue(value.page) &&
  isNumber(value.rowIndex) &&
  isNumber(value.columnIndex) &&
  typeof value.rawValue === "string" &&
  typeof value.isCurrency === "boolean";

const everyIsArrayOf = <T>(value: unknown, guard: (v: unknown) => v is T): value is T[] =>
  Array.isArray(value) && value.every(guard);

// Narrow an untrusted JSON body into a WireDocumentExtraction, or an
// EXTRACTION_FAILED DomainError describing the first structural violation.
export const parseDocumentExtraction = (
  body: unknown,
): Result<WireDocumentExtraction, DomainError> => {
  if (!isRecord(body) || typeof body.documentId !== "string") {
    return err(domainError("EXTRACTION_FAILED", "extraction payload missing documentId"));
  }
  if (!everyIsArrayOf(body.elements, isElement)) {
    return err(domainError("EXTRACTION_FAILED", "extraction payload has malformed elements"));
  }
  if (!everyIsArrayOf(body.chunks, isChunk)) {
    return err(domainError("EXTRACTION_FAILED", "extraction payload has malformed chunks"));
  }
  if (!everyIsArrayOf(body.tableCells, isTableCell)) {
    return err(domainError("EXTRACTION_FAILED", "extraction payload has malformed tableCells"));
  }
  return ok({
    documentId: body.documentId,
    elements: body.elements,
    chunks: body.chunks,
    tableCells: body.tableCells,
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
