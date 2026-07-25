import type { Result } from "../result";

// Read-only view of womblex's `*.embeddings.parquet` sibling (ADR-0014). The
// womblex sidecar reads its own Parquet and serves vectors as JSON floats over
// GET /embeddings/{evaluationId}/{documentId}; the adapter (Thread 20) parses
// them and the domain only sees plain data. Vectors join the extraction's chunks
// on chunkId — the same "{source_hash}:{chunk_index}" vocabulary the extraction
// seam already speaks.
//
// Thread 22 matches chunk vectors against topic definitions by cosine similarity.
// Vectors cross the boundary L2-normalised (ADR-0014), so that is a dot product.

export interface ChunkEmbedding {
  readonly chunkId: string; // "{source_hash}:{chunk_index}"
  readonly chunkIndex: number; // the explicit ordinal, so a consumer joins without parsing
  // Float32Array, not number[]: JavaScript numbers are 64-bit and a boxed array
  // costs 2–3× the memory for precision cosine similarity cannot use — a binding
  // constraint under the cloud memory limit (ADR-0014), not an optimisation.
  readonly values: Float32Array;
}

export interface DocumentEmbeddings {
  readonly documentId: string; // womblex source_hash
  // The producing model. Vectors from different models are incomparable, so a
  // consumer that cannot honour it must refuse rather than rank noise (ADR-0014).
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: readonly ChunkEmbedding[];
}

export interface IEmbeddingReader {
  // A document with no embed stage (or an air-gapped deployment) has no shard —
  // that is a NOT_FOUND, a legitimate outcome, not a broken extraction (ADR-0014).
  readEmbeddings(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<DocumentEmbeddings>>;
}
