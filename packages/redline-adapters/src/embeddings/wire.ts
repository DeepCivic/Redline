// The wire shape served by the womblex-ingest sidecar's retrieval read seam
// (`GET /embeddings/{evaluationId}/{documentId}`, ADR-0014). This is the one place
// that trusts the wire and narrows `unknown` → the domain's DocumentEmbeddings,
// parsing the JSON `number[]` into a `Float32Array` (a binding constraint, not an
// optimisation — ADR-0014). Kept internal to the adapter (not re-exported).

import {
  domainError,
  type DomainError,
  type DocumentEmbeddings,
  type ChunkEmbedding,
  type Result,
  err,
  ok,
} from "@redline/redline-domain";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(isNumber);

// Narrow one vector, parsing its values into a Float32Array. Returns null on any
// structural violation so the caller can name the document-level failure once.
const parseVector = (value: unknown, dimensions: number): ChunkEmbedding | null => {
  if (!isRecord(value)) return null;
  if (typeof value.chunkId !== "string") return null;
  if (!isNumber(value.chunkIndex)) return null;
  if (!isNumberArray(value.values)) return null;
  // A vector that disagrees with the declared dimensions is unmatchable; reject
  // it at the seam rather than let it fail as bad classifications downstream.
  if (value.values.length !== dimensions) return null;
  return {
    chunkId: value.chunkId,
    chunkIndex: value.chunkIndex,
    values: Float32Array.from(value.values),
  };
};

// Narrow an untrusted JSON body into a DocumentEmbeddings, or an EXTRACTION_FAILED
// DomainError describing the first structural violation.
export const parseDocumentEmbeddings = (
  body: unknown,
): Result<DocumentEmbeddings, DomainError> => {
  if (!isRecord(body) || typeof body.documentId !== "string") {
    return err(domainError("EXTRACTION_FAILED", "embeddings payload missing documentId"));
  }
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return err(domainError("EXTRACTION_FAILED", "embeddings payload missing model"));
  }
  if (!isNumber(body.dimensions)) {
    return err(domainError("EXTRACTION_FAILED", "embeddings payload missing dimensions"));
  }
  if (!Array.isArray(body.vectors)) {
    return err(domainError("EXTRACTION_FAILED", "embeddings payload has malformed vectors"));
  }

  const vectors: ChunkEmbedding[] = [];
  for (const raw of body.vectors) {
    const vector = parseVector(raw, body.dimensions);
    if (!vector) {
      return err(domainError("EXTRACTION_FAILED", "embeddings payload has a malformed vector"));
    }
    vectors.push(vector);
  }

  return ok({
    documentId: body.documentId,
    model: body.model,
    dimensions: body.dimensions,
    vectors,
  });
};

// Best-effort read of the sidecar's Result-shaped error body for a non-2xx
// response; falls back to the HTTP status when the body is not shaped as expected.
export const parseErrorBody = (status: number, body: unknown): DomainError => {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    const code = typeof body.error.code === "string" ? body.error.code : "INFRA_FAILURE";
    // The sidecar's NOT_FOUND maps straight through — an absent embed stage is a
    // legitimate outcome (ADR-0014); anything else at this seam is a failure.
    const mapped = code === "NOT_FOUND" ? "NOT_FOUND" : "EXTRACTION_FAILED";
    return domainError(mapped, body.error.message);
  }
  return domainError("INFRA_FAILURE", `womblex-ingest returned HTTP ${status}`);
};
