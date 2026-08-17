// The report data model (build plan §2). No entities above these rows — a run
// lands one ReportRow per document, one FieldValue per column on that row.

export type FieldStatus = "verified" | "missing" | "needs_review";

export type ColumnConstraint = { readonly kind: "financial"; readonly currency?: string } | { readonly kind: "date" };

export interface ReportColumn {
  readonly columnId: string;
  readonly name: string;
  readonly semanticDescription: string;
  readonly constraint?: ColumnConstraint;
}

export interface Evidence {
  readonly documentId: string; // womblex source_hash
  readonly chunkId: string; // "{documentId}:{chunkIndex}"
  readonly quotedText: string; // contiguous substring of that chunk — see §4 rule 3
}

export interface FieldValue {
  readonly columnId: string;
  readonly rawValue: string | null; // as the model returned it, never rewritten
  readonly normalisedValue: string | null; // constraint output; null when normalisation failed
  readonly status: FieldStatus;
  readonly evidence: readonly Evidence[];
  readonly reason: string | null; // why it is missing or needs review
}

export interface ReportRow {
  readonly documentId: string;
  readonly values: readonly FieldValue[];
}

export type ReportRunStatus = "pending" | "running" | "complete" | "failed";

export interface ReportRun {
  readonly runId: string;
  readonly corpusId: string;
  readonly definitionId: string;
  readonly documentIds: readonly string[];
  readonly status: ReportRunStatus;
}
