import type { Result } from "../result";

// The staged-corpus picker's read surface. It exists because an evaluation's id
// is not free: the same string addresses the corpus in object storage
// (`proc/{evaluationId}/`), in the store (`redline_chunks.evaluation_id`) and at
// the sidecar (`/extractions/{evaluation_id}/{document_id}`). An operator who
// retypes it wrongly gets an evaluation whose documents cannot be read, and
// nothing fails until classification returns nothing. Listing what is staged
// turns that invariant into a choice the UI can offer.
//
// Read-only, and deliberately not on IChunkStore: that port is the classifier's
// provenance-addressed fetch surface, keyed by an evaluation that already
// exists. This one answers the question asked *before* there is an evaluation.

// A corpus the sidecar's load path has already put in the store. `corpusId`
// becomes the created evaluation's id — they are the same string by
// construction, which is what keeps the read path joinable.
export interface StagedCorpus {
  readonly corpusId: string;
  readonly documentCount: number;
}

// One staged document. `documentId` is womblex's source_hash, which is opaque to
// a specialist, so `preview` carries the opening passage — enough to tell one
// tender response from another without opening it.
export interface StagedDocument {
  readonly documentId: string;
  readonly chunkCount: number;
  readonly preview: string;
}

export interface IStagedCorpusReader {
  // Every corpus with staged content, ordered by id so the picker is stable
  // across calls. An empty store lists nothing rather than failing — "no corpus
  // has been staged yet" is a state the screen renders, not an error.
  listCorpora(): Promise<Result<readonly StagedCorpus[]>>;

  // The documents behind one corpus, ordered by id. A corpus with no staged
  // content is NOT_FOUND: offering it would let an operator create an
  // evaluation that can never be run.
  listDocuments(corpusId: string): Promise<Result<readonly StagedDocument[]>>;
}
