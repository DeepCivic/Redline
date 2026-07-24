// The financial extension's read-seam wire shape, narrowed from `unknown` in one
// place so the NumbatchFinancialExtractor stays a thin mapping. Mirrors the
// overlay's `DocumentExtractionsRead` schema (services/numbatch/financial_extension
// — GET /financial-extractions/{source_doc_id}):
//
//   { source_doc_id, extractions: [
//       { topic_id, amount: "1500.50"|null, currency: "AUD"|null,
//         description, source_elem_order: 7|null }, … ] }
//
// Pydantic serialises the Numeric `amount` as a JSON *string* (or null); this
// module is the single place that decimal string is parsed to a number. Kept
// internal to the adapter (not re-exported).

import { domainError, type DomainError, type Result, err, ok } from "@redline/redline-domain";

export interface WireFinancialExtraction {
  readonly topicId: string;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly description: string;
  readonly sourceElemOrder: number | null;
}

export interface WireDocumentExtractions {
  readonly sourceDocId: string;
  readonly extractions: readonly WireFinancialExtraction[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// Pydantic renders the Numeric column as a decimal *string*; accept that or a
// JSON number, and null for the description-fallback case.
const parseAmount = (value: unknown): Result<number | null, DomainError> => {
  if (value === null) return ok(null);
  if (isNumber(value)) return ok(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return ok(parsed);
  }
  return err(domainError("EXTRACTION_FAILED", "financial extraction has a malformed amount"));
};

const parseElemOrder = (value: unknown): number | null =>
  isNumber(value) ? value : null;

const parseExtraction = (
  value: unknown,
): Result<WireFinancialExtraction, DomainError> => {
  if (!isRecord(value) || typeof value.topic_id !== "string") {
    return err(domainError("EXTRACTION_FAILED", "financial extraction missing topic_id"));
  }
  if (typeof value.description !== "string") {
    return err(domainError("EXTRACTION_FAILED", "financial extraction missing description"));
  }
  const amount = parseAmount(value.amount);
  if (amount.error) return err(amount.error);
  const currency = typeof value.currency === "string" ? value.currency : null;
  return ok({
    topicId: value.topic_id,
    amount: amount.data,
    currency,
    description: value.description,
    sourceElemOrder: parseElemOrder(value.source_elem_order),
  });
};

// Narrow the GET /financial-extractions/{doc} body into typed records, or the
// first structural violation as an EXTRACTION_FAILED DomainError.
export const parseDocumentExtractions = (
  body: unknown,
): Result<WireDocumentExtractions, DomainError> => {
  if (!isRecord(body) || typeof body.source_doc_id !== "string") {
    return err(domainError("EXTRACTION_FAILED", "extractions payload missing source_doc_id"));
  }
  if (!Array.isArray(body.extractions)) {
    return err(domainError("EXTRACTION_FAILED", "extractions payload is not a list"));
  }
  const extractions: WireFinancialExtraction[] = [];
  for (const entry of body.extractions) {
    const parsed = parseExtraction(entry);
    if (parsed.error) return err(parsed.error);
    extractions.push(parsed.data);
  }
  return ok({ sourceDocId: body.source_doc_id, extractions });
};

// Best-effort read of a non-2xx body. The financial extension returns FastAPI's
// `{ "detail": … }` for validation errors and the Result-shaped
// `{ "error": { code, message } }` for its own 404s; anything at the read seam is
// an extraction failure from the domain's point of view, except plain transport
// errors which the adapter classifies as INFRA_FAILURE by HTTP status fallback.
export const parseErrorBody = (status: number, body: unknown): DomainError => {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    return domainError("EXTRACTION_FAILED", body.error.message);
  }
  if (isRecord(body) && typeof body.detail === "string") {
    return domainError("EXTRACTION_FAILED", body.detail);
  }
  return domainError("INFRA_FAILURE", `numbatch financial read returned HTTP ${status}`);
};
