import type { Result } from "../result";

// redline's first write-side object-store port. Every other object-store seam in
// redline is a read — the womblex engine writes shards and the sidecar reads them
// back (architecture §5 invariant 2). This one puts a specialist's chosen bytes
// into redline's own bucket under `proc/{evaluationId}/inputs/`, which is the
// prefix the womblex runner resolves its input from, so a browser upload reaches
// a run without a terminal `mc cp` in the loop.
//
// It stages bytes only. It does not extract, chunk, or mint a source_hash —
// womblex does all of that when the run drains, and the source_hash it computes
// becomes the document identity the evaluation later references. So this port
// carries no document identity of its own: the object key is the file name under
// the evaluation's prefix, and the specialist's evaluation id is the prefix.
//
// The list/browse half (enumerating raw objects a run has not processed yet) is
// deliberately not here — the run surface leads over the already-staged path
// `IStagedCorpusReader` serves, and browse waits with the document-selection work.

// One document to stage. `bytes` is the file's content, `contentType` its MIME
// type (stored as object metadata, never inspected here), and `fileName` the
// leaf key under the evaluation's input prefix — a name a specialist recognises,
// not a hash, because womblex has not seen these bytes yet.
export interface StagedUpload {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface IStagedCorpusWriter {
  // Put one document's bytes under `proc/{evaluationId}/inputs/{fileName}` and
  // return the key it landed at. A staged object is an input to a run that has
  // not happened; nothing downstream reads it until womblex extracts it. A bucket
  // failure returns INFRA_FAILURE rather than throwing, so no driver exception
  // crosses the seam.
  stage(
    evaluationId: string,
    upload: StagedUpload,
  ): Promise<Result<{ readonly key: string }>>;
}
