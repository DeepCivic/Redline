import type { Result } from "../result";

// Pulls the currency figures (or description fallback) that the Numbatch
// financial-extraction worker (Thread 7) wrote for a response group's documents,
// with provenance back to womblex elements. Feeds ProcurementResponse.costing.

export interface FinancialExtractionRequest {
  readonly evaluationId: string;
  readonly responseGroupId: string;
  readonly documentIds: readonly string[];
}

// estimateAud is null when only a prose description of costs was available — the
// domain keeps both so the review grid can show a numeric cell or the fallback.
// Keyed on (documentId, requirementId): the Numbatch financial worker (Thread 7)
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
