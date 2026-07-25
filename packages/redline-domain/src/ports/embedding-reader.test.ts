import { describe, it, expect } from "vitest";
import { isOk, ok, type Result } from "../result";
import { domainError } from "../errors/domain-error";
import type {
  ChunkEmbedding,
  DocumentEmbeddings,
  IEmbeddingReader,
} from "./embedding-reader";

// The port's spec: a fake proves it is implementable and shaped as Thread 22
// (retrieval classification) will consume it. Vectors are Float32Array — a
// binding constraint from ADR-0014, not number[], so cosine similarity stays a
// dot product over packed floats.

class InMemoryEmbeddingReader implements IEmbeddingReader {
  private readonly documents = new Map<string, DocumentEmbeddings>();

  seed(evaluationId: string, embeddings: DocumentEmbeddings): void {
    this.documents.set(`${evaluationId}::${embeddings.documentId}`, embeddings);
  }

  async readEmbeddings(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<DocumentEmbeddings>> {
    const found = this.documents.get(`${evaluationId}::${documentId}`);
    if (!found) return { error: domainError("NOT_FOUND", "no embeddings") };
    return ok(found);
  }
}

describe("IEmbeddingReader (in-memory fake)", () => {
  it("returns a document's vectors as Float32Array, joinable on chunkId", async () => {
    const reader = new InMemoryEmbeddingReader();
    const chunk: ChunkEmbedding = {
      chunkId: "hashA:0",
      chunkIndex: 0,
      values: Float32Array.from([0.6, 0.8]),
    };
    reader.seed("e1", {
      documentId: "hashA",
      model: "stub-deterministic-v1",
      dimensions: 2,
      vectors: [chunk],
    });

    const result = await reader.readEmbeddings("e1", "hashA");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.documentId).toBe("hashA");
    expect(result.data.model).toBe("stub-deterministic-v1");
    expect(result.data.dimensions).toBe(2);
    const vector = result.data.vectors[0]!;
    expect(vector.values).toBeInstanceOf(Float32Array);
    expect(vector.chunkId).toBe("hashA:0");
    // The composite key decomposes into the (source_hash, chunk_index) pair.
    const [sourceHash, chunkIndex] = vector.chunkId.split(":");
    expect(sourceHash).toBe(result.data.documentId);
    expect(Number(chunkIndex)).toBe(vector.chunkIndex);
  });

  it("reports NOT_FOUND when a document has no embeddings shard", async () => {
    const reader = new InMemoryEmbeddingReader();

    const result = await reader.readEmbeddings("e1", "missing");

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});
