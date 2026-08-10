import type { Result } from "../result";

// Classifies a response group's chunks against the evaluation's user-defined
// requirement set (a Numbatch profile of ≤10 topics). Numbatch
// implements this over its batch-inference + document-rollup surface; the
// adapter maps Numbatch `topic_id` → `requirementId` (ADR-0004).

export interface ClassificationRequest {
  readonly evaluationId: string;
  readonly responseGroupId: string;
  readonly documentIds: readonly string[];
}

// Why a document produced no requirement match. The two reasons mean different
// things to whoever runs the evaluation and must stay distinguishable (a grid is
// made of rows, so an unmatched document is invisible unless it carries one):
//   - "addressed_nothing": the document was read and adjudicated, and answered
//     none of the lens's topics — the vendor answered nothing we asked;
//   - "no_extraction": the store held no chunks for the document — we never read
//     the file.
export type UnclassifiedReason = "addressed_nothing" | "no_extraction";

// A single per-(document, requirement) classification result: which user-defined
// requirement matched, the roll-up confidence, and the chunk that carried the
// strongest signal. A document may match more than one requirement (roll-ups are
// multi-label, ≤3 topics), so the port returns one row per matched requirement.
//
// A document that matched no requirement still emits one row, carrying an
// `unclassified` reason and a null `requirementId`, so a specialist sees it in
// the grid rather than having it vanish. A matched row leaves `unclassified`
// null. `sourceElementOrder` is the element the evidence chunk came from when
// the path can resolve it, so a row's deep-link lands on its own passage rather
// than the top of the document; null when unknown.
export interface RequirementClassification {
  readonly documentId: string;
  readonly requirementId: string | null;
  readonly confidence: number;
  readonly sourceChunkId: string | null;
  readonly sourceElementOrder: number | null;
  readonly unclassified: UnclassifiedReason | null;
}

export interface IProcurementClassifier {
  classifyResponseGroup(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>>;
}
