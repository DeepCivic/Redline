import type { Result } from "../result";
import type { ResponseCategorisation } from "../entities/procurement-response";
import type { RequirementNumber } from "../entities/procurement-requirement";

// Classifies a response group's chunks against the fixed 1–6 requirement profile
// plus its user-defined categories. Numbatch (Thread 5) implements this over its
// batch-inference + document-rollup surface.

export interface ClassificationRequest {
  readonly evaluationId: string;
  readonly responseGroupId: string;
  readonly documentIds: readonly string[];
}

// A single per-document classification result: which requirement matched, the
// user-defined categorisation, and the chunk that carried the strongest signal.
export interface RequirementClassification {
  readonly documentId: string;
  readonly requirementNumber: RequirementNumber;
  readonly categorisation: ResponseCategorisation;
  readonly confidence: number;
  readonly sourceChunkId: string | null;
}

export interface IProcurementClassifier {
  classifyResponseGroup(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>>;
}
