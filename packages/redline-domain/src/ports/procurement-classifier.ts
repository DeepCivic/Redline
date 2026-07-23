import type { Result } from "../result";

// Classifies a response group's chunks against the evaluation's user-defined
// requirement set (a Numbatch profile of ≤10 topics). Numbatch (Thread 5)
// implements this over its batch-inference + document-rollup surface; the
// adapter maps Numbatch `topic_id` → `requirementId` (ADR-0004).

export interface ClassificationRequest {
  readonly evaluationId: string;
  readonly responseGroupId: string;
  readonly documentIds: readonly string[];
}

// A single per-document classification result: which user-defined requirement
// matched, the roll-up confidence, and the chunk that carried the strongest
// signal. A document may match more than one requirement (roll-ups are
// multi-label, ≤3 topics), so the port returns one row per matched requirement.
export interface RequirementClassification {
  readonly documentId: string;
  readonly requirementId: string;
  readonly confidence: number;
  readonly sourceChunkId: string | null;
}

export interface IProcurementClassifier {
  classifyResponseGroup(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>>;
}
