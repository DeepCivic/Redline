import type { Result } from "../result";
import type { Evidence, ReportColumn } from "../report/types";

// The base LLM extraction call (build plan §4). One call per document with
// tools attached — the tools themselves are wired by the adapter, not carried
// on this port; the port only states what columns were offered and what came
// back. The three rejection rules (unoffered column, evidence citing an
// unreturned chunk, non-substring quote) are enforced by the caller against
// this response, never trusted from the model.

export interface ExtractionColumnResult {
  readonly columnId: string;
  readonly value: string | null;
  readonly evidence: readonly Evidence[];
  readonly absent: boolean;
  readonly reason: string | null;
}

export interface ExtractionModelRequest {
  readonly corpusId: string;
  readonly runId: string;
  readonly documentId: string;
  readonly columns: readonly ReportColumn[];
}

export interface IExtractionModel {
  extract(request: ExtractionModelRequest): Promise<Result<readonly ExtractionColumnResult[]>>;
}
