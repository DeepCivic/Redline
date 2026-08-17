import type { Result } from "../result";

// Stages a raw document into a corpus, ahead of any womblex run over it.
// documentId is the sha256 of the bytes — the same hash womblex computes as
// source_hash (store/output.py `_source_hash`) — so the id a caller gets back
// here is already the id that run-scoped reads will key on once a run lands.

export interface IStagedCorpusWriter {
  writeDocument(
    corpusId: string,
    filename: string,
    content: Uint8Array,
  ): Promise<Result<{ readonly documentId: string }>>;
}
