import type { Result } from "../result";

// Embeds arbitrary text into a query vector, in the *same* space as the chunk
// vectors IEmbeddingReader returns (ADR-0014). redline's TypeScript links no
// embedding model, so the womblex-ingest sidecar owns this too: the adapter
// (Thread 22) calls its POST /embeddings/query endpoint (Thread 20a), which
// declares the producing model and L2-normalises the vector exactly as the
// chunk embedder does.
//
// The retrieval stage (Thread 22) embeds a topic definition with this port and
// ranks a document's chunk vectors against it by cosine similarity. That is only
// meaningful when the query and the chunks share a model: `model` crosses the
// boundary so the consumer can refuse a mismatch rather than rank noise.

export interface QueryEmbedding {
  // The producing model. A query vector is comparable to a chunk vector only
  // when both declare the same model (ADR-0014); the consumer checks it.
  readonly model: string;
  readonly dimensions: number;
  // Float32Array, not number[]: the same binding memory constraint the chunk
  // vectors cross under (ADR-0014), so the two sit in one representation and
  // cosine similarity is a dot product over packed floats.
  readonly values: Float32Array;
}

export interface ITextEmbedder {
  // A query is chunk-free and never persisted, so it carries no join key — it
  // is only ever compared, never stored (Thread 20a). Blank text is an
  // INVALID_REQUEST at the seam, not a zero vector.
  embed(text: string): Promise<Result<QueryEmbedding>>;
}
