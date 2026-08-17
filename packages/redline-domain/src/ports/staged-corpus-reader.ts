import type { Result } from "../result";

// Lists documents staged into a corpus, ahead of any womblex run — the
// selection surface the product statement's "user selects documents" step
// reads from. Pre-run, so only what staging itself knows (id, filename);
// extraction status/counts belong to the run-scoped MANIFEST_SCHEMA reads
// step 3 adds, not this port.

export interface StagedDocument {
  readonly documentId: string; // sha256 of the content — see staged-corpus-writer
  readonly filename: string;
}

export interface IStagedCorpusReader {
  listDocuments(corpusId: string): Promise<Result<readonly StagedDocument[]>>;
}
