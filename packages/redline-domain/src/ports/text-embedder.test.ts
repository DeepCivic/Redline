import { describe, it, expect } from "vitest";
import { isOk, ok, type Result } from "../result";
import { domainError } from "../errors/domain-error";
import type { ITextEmbedder, QueryEmbedding } from "./text-embedder";

// The port's spec: a fake proves it is implementable and shaped as Thread 22
// (retrieval classification) will consume it. A query vector declares its model
// so the consumer can refuse comparing across incomparable spaces (ADR-0014),
// and its values are Float32Array so the match is a dot product over the same
// representation the chunk vectors cross under.

class InMemoryTextEmbedder implements ITextEmbedder {
  constructor(
    private readonly model: string,
    private readonly dimensions: number,
  ) {}

  async embed(text: string): Promise<Result<QueryEmbedding>> {
    const trimmed = text.trim();
    if (trimmed === "") {
      return { error: domainError("VALIDATION_FAILED", "text must not be empty") };
    }
    // A crude deterministic stand-in: it is not a real embedding, only enough
    // to prove the port's shape and that the same text embeds identically.
    const values = new Float32Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i += 1) {
      values[i] = ((trimmed.charCodeAt(i % trimmed.length) % 17) - 8) / 8;
    }
    return ok({ model: this.model, dimensions: this.dimensions, values });
  }
}

describe("ITextEmbedder (in-memory fake)", () => {
  it("returns a query vector declaring its model and dimensions", async () => {
    const embedder = new InMemoryTextEmbedder("stub-deterministic-v1", 8);

    const result = await embedder.embed("network security controls");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.model).toBe("stub-deterministic-v1");
    expect(result.data.dimensions).toBe(8);
    expect(result.data.values).toBeInstanceOf(Float32Array);
    expect(result.data.values.length).toBe(8);
  });

  it("rejects blank text rather than returning a zero vector", async () => {
    const embedder = new InMemoryTextEmbedder("stub-deterministic-v1", 8);

    const result = await embedder.embed("   ");

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
