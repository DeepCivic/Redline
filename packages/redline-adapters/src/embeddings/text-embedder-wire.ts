// The wire shape served by the womblex-ingest sidecar's query-embedding seam
// (`POST /embeddings/query`, ADR-0014 / Thread 20a). This is the one place that
// trusts the wire and narrows `unknown` → the domain's QueryEmbedding, parsing
// the JSON `number[]` into a `Float32Array` (the same binding constraint the
// chunk vectors cross under — ADR-0014). Kept internal to the adapter.

import {
  domainError,
  type DomainError,
  type QueryEmbedding,
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

// Narrow an untrusted JSON body into a QueryEmbedding, or a VALIDATION_FAILED
// DomainError describing the first structural violation. The query is chunk-free
// (Thread 20a): no join key to validate, only the model/dimensions/values triple.
export const parseQueryEmbedding = (
  body: unknown,
): Result<QueryEmbedding, DomainError> => {
  if (!isRecord(body) || typeof body.model !== "string" || body.model.trim() === "") {
    return err(domainError("VALIDATION_FAILED", "query embedding payload missing model"));
  }
  if (!isNumber(body.dimensions)) {
    return err(domainError("VALIDATION_FAILED", "query embedding payload missing dimensions"));
  }
  if (!isNumberArray(body.values)) {
    return err(domainError("VALIDATION_FAILED", "query embedding payload has malformed values"));
  }
  // A query vector whose length disagrees with its own declared dimensions is
  // unmatchable against any chunk; reject it at the seam, as the chunk reader does.
  if (body.values.length !== body.dimensions) {
    return err(
      domainError("VALIDATION_FAILED", "query embedding values disagree with dimensions"),
    );
  }
  return ok({
    model: body.model,
    dimensions: body.dimensions,
    values: Float32Array.from(body.values),
  });
};

// Best-effort read of the sidecar's Result-shaped error body for a non-2xx
// response; falls back to the HTTP status when the body is not shaped as expected.
// The query seam's only client-side error is INVALID_REQUEST (blank text) — a
// caller mistake, mapped to VALIDATION_FAILED; anything else is INFRA_FAILURE.
export const parseErrorBody = (status: number, body: unknown): DomainError => {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
    const code = typeof body.error.code === "string" ? body.error.code : "INFRA_FAILURE";
    const mapped = code === "INVALID_REQUEST" ? "VALIDATION_FAILED" : "INFRA_FAILURE";
    return domainError(mapped, body.error.message);
  }
  return domainError("INFRA_FAILURE", `womblex-ingest returned HTTP ${status}`);
};
