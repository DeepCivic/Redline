import type { Result } from "../result";

// Pulls the currency figures (or description fallback) that the Numbatch
// financial-extraction worker wrote for a response group's documents,
// with provenance back to womblex elements. Feeds ProcurementResponse.costing.

// A document's money spans (womblex `money`) carry no requirementId — they are
// (document, table, row, col) facts. The money-span-backed extractor attributes a
// document's spans to the requirement its classification matched; `matchedRequirements`
// carries that binding into the request so the extractor can key its output on
// (documentId, requirementId). The Numbatch extractor ignores it (it reads its own
// per-topic figures). Absent or empty ⇒ a money-span extractor emits nothing for
// that document (no requirement to attribute the money to).
export interface MatchedRequirement {
  readonly documentId: string;
  readonly requirementId: string;
  readonly confidence: number;
}

export interface FinancialExtractionRequest {
  readonly evaluationId: string;
  readonly responseGroupId: string;
  readonly documentIds: readonly string[];
  readonly matchedRequirements?: readonly MatchedRequirement[];
}

// estimateAud is null when only a prose description of costs was available — the
// domain keeps both so the review grid can show a numeric cell or the fallback.
// Keyed on (documentId, requirementId): the Numbatch financial worker
// writes one figure per (document, requirement) via the roll-up's deduped
// matched-chunk provenance — no per-requirement re-extraction (ADR-0004).
export interface FinancialExtraction {
  readonly documentId: string;
  readonly requirementId: string;
  readonly elementOrder: number;
  readonly estimateAud: number | null;
  readonly description: string;
}

export interface IFinancialExtractor {
  extractFinancials(
    request: FinancialExtractionRequest,
  ): Promise<Result<readonly FinancialExtraction[]>>;
}
