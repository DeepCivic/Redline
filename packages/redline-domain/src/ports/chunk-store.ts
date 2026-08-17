import type { Result } from "../result";

// Reads chunks from a womblex run (CHUNKS_SCHEMA — see the 0c corpus sample,
// services/womblex-ingest/tests/fixtures/run-throsby-demo). Every read is
// run-scoped (corpusId + runId): a corpus read the wrong way merges every run
// under it and doubles evidence (build plan §8 blocker 1).

export interface Chunk {
  readonly chunkId: string; // "{documentId}:{chunkIndex}" — matches Evidence.chunkId
  readonly documentId: string; // womblex source_hash
  readonly chunkIndex: number;
  readonly text: string;
  readonly startChar: number;
  readonly endChar: number;
  readonly contentType: string; // observed: "narrative"; table/sheet chunks are a distinct content_type this sample has none of
  readonly hasRedaction: boolean;
  readonly pageStart: number | null;
  readonly pageEnd: number | null;
  readonly elemOrder: number | null; // populated only for table chunks (CHUNKS_SCHEMA); null for narrative
}

export interface IChunkStore {
  readChunks(corpusId: string, runId: string, documentId: string): Promise<Result<readonly Chunk[]>>;
}
