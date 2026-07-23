// The Numbatch HTTP surface the NumbatchClassifier depends on, narrowed from
// `unknown` in one place so the classifier itself stays a thin mapping. Shapes
// mirror Numbatch's real API (DeepCivic/Numbatch — docs/ARCHITECTURE.md,
// docs/DATA_MODEL.md), verified against source, not training data:
//
//   POST /batch-inference/trigger  { profile_id, strategy, source_doc_ids? }
//     → { id, status, ... }                              (a batch_inference_job)
//   GET  /batch-inference/jobs/{id}
//     → { id, status: queued|running|succeeded|failed, error? }
//   GET  /batch-inference/jobs/{id}/documents
//     → [ { source_doc_id, status: Classified|Unclassified,
//           topics: [ { topic_id, name, score, chunks_matched }, … ] }, … ]
//
// Numbatch uses snake_case on the wire; this module is the single place that
// vocabulary is read. Kept internal to the adapter (not re-exported).

import { domainError, type DomainError, type Result, err, ok } from "@redline/redline-domain";

// A batch-inference job's lifecycle, shared by the trigger response and the
// status poll (DATA_MODEL.md: queued → running → succeeded | failed).
export type NumbatchJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface WireBatchJob {
  readonly id: string;
  readonly status: NumbatchJobStatus;
  readonly error: string | null;
}

// One topic prediction within a document roll-up. `score` is the roll-up score
// (0–1); `topic_id` is what maps to a redline requirementId.
export interface WireDocumentTopic {
  readonly topicId: string;
  readonly score: number;
}

// One document's aggregated classification (document_classifications). `topics`
// is sorted by score, ≤3 entries; empty ⇒ Unclassified.
export interface WireDocumentClassification {
  readonly sourceDocId: string;
  readonly status: string;
  readonly topics: readonly WireDocumentTopic[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const JOB_STATUSES: readonly NumbatchJobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
];

const isJobStatus = (value: unknown): value is NumbatchJobStatus =>
  typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);

// Narrow a batch-inference job body (trigger response or status poll). Accepts
// an absent/null `error` — Numbatch only sets it on a fatal failure.
export const parseBatchJob = (body: unknown): Result<WireBatchJob, DomainError> => {
  if (!isRecord(body) || typeof body.id !== "string") {
    return err(domainError("CLASSIFICATION_FAILED", "batch job payload missing id"));
  }
  if (!isJobStatus(body.status)) {
    return err(domainError("CLASSIFICATION_FAILED", "batch job payload has unknown status"));
  }
  const error = typeof body.error === "string" ? body.error : null;
  return ok({ id: body.id, status: body.status, error });
};

const isDocumentTopic = (value: unknown): value is WireDocumentTopic =>
  isRecord(value) && typeof value.topic_id === "string" && isNumber(value.score);

const toDocumentTopic = (value: WireDocumentTopic & { topic_id: string }): WireDocumentTopic => ({
  topicId: value.topic_id,
  score: value.score,
});

const parseDocument = (value: unknown): Result<WireDocumentClassification, DomainError> => {
  if (!isRecord(value) || typeof value.source_doc_id !== "string") {
    return err(
      domainError("CLASSIFICATION_FAILED", "roll-up document missing source_doc_id"),
    );
  }
  if (typeof value.status !== "string") {
    return err(domainError("CLASSIFICATION_FAILED", "roll-up document missing status"));
  }
  if (!Array.isArray(value.topics) || !value.topics.every(isDocumentTopic)) {
    return err(domainError("CLASSIFICATION_FAILED", "roll-up document has malformed topics"));
  }
  return ok({
    sourceDocId: value.source_doc_id,
    status: value.status,
    topics: value.topics.map((topic) => toDocumentTopic(topic as WireDocumentTopic & { topic_id: string })),
  });
};

// Narrow the document roll-up list (GET .../documents) into typed records, or
// the first structural violation as a CLASSIFICATION_FAILED DomainError.
export const parseDocumentRollup = (
  body: unknown,
): Result<readonly WireDocumentClassification[], DomainError> => {
  if (!Array.isArray(body)) {
    return err(domainError("CLASSIFICATION_FAILED", "roll-up payload is not a list"));
  }
  const documents: WireDocumentClassification[] = [];
  for (const entry of body) {
    const parsed = parseDocument(entry);
    if (parsed.error) return err(parsed.error);
    documents.push(parsed.data);
  }
  return ok(documents);
};

// Best-effort read of a non-2xx Numbatch body. Numbatch returns FastAPI's
// `{ "detail": … }`; anything at the classify seam is a classification failure.
export const parseErrorBody = (status: number, body: unknown): DomainError => {
  if (isRecord(body) && typeof body.detail === "string") {
    return domainError("CLASSIFICATION_FAILED", body.detail);
  }
  return domainError("INFRA_FAILURE", `numbatch returned HTTP ${status}`);
};
