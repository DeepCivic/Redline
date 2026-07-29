import { describe, it, expect } from "vitest";
import {
  isOk,
  makeTopic,
  ok,
  type DocumentEmbeddings,
  type IEmbeddingReader,
  type ITextEmbedder,
  type QueryEmbedding,
  type Result,
  type Topic,
} from "@redline/redline-domain";
import { ClassifyByRetrieval } from "./classify-by-retrieval";

// Retrieval classification — the lens's first-pass model-free stage
// (design doc §3, "retrieval → clear match"). It ranks a document's chunk
// vectors against each topic definition's query vector by cosine similarity
// (a dot product, since both cross L2-normalised — ADR-0014) and emits the same
// RequirementClassification the hard-rule and Numbatch paths do (D2), so the
// three paths interchange at the port. No trained adapter, no samples.

const MODEL = "stub-deterministic-v1";

// A fixture corpus in a tiny, hand-chosen 2-D space so the nearest neighbour is
// obvious by eye. Unit vectors, so a dot product is the cosine similarity.
const topicSecurity = (): Topic => {
  const t = makeTopic({
    id: "topic-security",
    name: "Security",
    definition: "network security controls",
  });
  if (!isOk(t)) throw new Error("fixture topic must construct");
  return t.data;
};

const topicPricing = (): Topic => {
  const t = makeTopic({
    id: "topic-pricing",
    name: "Pricing",
    definition: "unit price and totals",
  });
  if (!isOk(t)) throw new Error("fixture topic must construct");
  return t.data;
};

// A text embedder fake: maps each definition to a known unit vector so the
// document→topic match is deterministic and inspectable.
class FakeTextEmbedder implements ITextEmbedder {
  public calls: string[] = [];
  constructor(private readonly byText: Record<string, readonly number[]>) {}

  async embed(text: string): Promise<Result<QueryEmbedding>> {
    this.calls.push(text);
    const values = this.byText[text];
    if (!values) {
      return { error: { code: "VALIDATION_FAILED", message: `no fixture vector for ${text}` } };
    }
    return ok({ model: MODEL, dimensions: values.length, values: Float32Array.from(values) });
  }
}

// An embedding reader fake seeded with each document's chunk vectors.
class FakeEmbeddingReader implements IEmbeddingReader {
  private readonly docs = new Map<string, DocumentEmbeddings>();
  constructor(seed: readonly DocumentEmbeddings[]) {
    for (const d of seed) this.docs.set(d.documentId, d);
  }

  async readEmbeddings(
    _evaluationId: string,
    documentId: string,
  ): Promise<Result<DocumentEmbeddings>> {
    const found = this.docs.get(documentId);
    if (!found) return { error: { code: "NOT_FOUND", message: `no embeddings for ${documentId}` } };
    return ok(found);
  }
}

const docEmbeddings = (
  documentId: string,
  vectors: readonly { chunkId: string; chunkIndex: number; values: readonly number[] }[],
): DocumentEmbeddings => ({
  documentId,
  model: MODEL,
  dimensions: vectors[0]?.values.length ?? 0,
  vectors: vectors.map((v) => ({
    chunkId: v.chunkId,
    chunkIndex: v.chunkIndex,
    values: Float32Array.from(v.values),
  })),
});

// Definitions live at orthogonal axes; each document's strongest chunk sits on
// one of them, so the nearest topic is unambiguous.
const definitionVectors = {
  "network security controls": [1, 0],
  "unit price and totals": [0, 1],
} as const;

describe("ClassifyByRetrieval", () => {
  const topics = [topicSecurity(), topicPricing()];

  const request = {
    evaluationId: "eval-1",
    responseGroupId: "group-1",
    documentIds: ["doc-sec", "doc-price"],
  };

  it("classifies a fixture corpus with no trained adapter and no samples", async () => {
    const embedder = new FakeTextEmbedder(definitionVectors);
    const reader = new FakeEmbeddingReader([
      docEmbeddings("doc-sec", [{ chunkId: "doc-sec:0", chunkIndex: 0, values: [1, 0] }]),
      docEmbeddings("doc-price", [{ chunkId: "doc-price:0", chunkIndex: 0, values: [0, 1] }]),
    ]);
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    const result = await useCase.execute({ request, topics });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // The security document lands on the security topic, the pricing doc on pricing.
    expect(result.data).toContainEqual({
      documentId: "doc-sec",
      requirementId: "topic-security",
      confidence: 1,
      sourceChunkId: "doc-sec:0",
    });
    expect(result.data).toContainEqual({
      documentId: "doc-price",
      requirementId: "topic-pricing",
      confidence: 1,
      sourceChunkId: "doc-price:0",
    });
  });

  it("emits the RequirementClassification shape (interchangeable with the other paths)", async () => {
    const embedder = new FakeTextEmbedder(definitionVectors);
    const reader = new FakeEmbeddingReader([
      docEmbeddings("doc-sec", [{ chunkId: "doc-sec:0", chunkIndex: 0, values: [1, 0] }]),
    ]);
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    const result = await useCase.execute({
      request: { ...request, documentIds: ["doc-sec"] },
      topics,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const row = result.data[0]!;
    expect(Object.keys(row).sort()).toEqual(
      ["confidence", "documentId", "requirementId", "sourceChunkId"].sort(),
    );
  });

  it("names the strongest chunk as the source, not merely the first", async () => {
    const embedder = new FakeTextEmbedder(definitionVectors);
    // The second chunk is the closer match to the security definition [1, 0].
    const reader = new FakeEmbeddingReader([
      docEmbeddings("doc-sec", [
        { chunkId: "doc-sec:0", chunkIndex: 0, values: [0.6, 0.8] },
        { chunkId: "doc-sec:1", chunkIndex: 1, values: [1, 0] },
      ]),
    ]);
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    const result = await useCase.execute({
      request: { ...request, documentIds: ["doc-sec"] },
      topics,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]?.sourceChunkId).toBe("doc-sec:1");
    expect(result.data[0]?.requirementId).toBe("topic-security");
  });

  it("embeds each topic definition once, not once per document", async () => {
    const embedder = new FakeTextEmbedder(definitionVectors);
    const reader = new FakeEmbeddingReader([
      docEmbeddings("doc-sec", [{ chunkId: "doc-sec:0", chunkIndex: 0, values: [1, 0] }]),
      docEmbeddings("doc-price", [{ chunkId: "doc-price:0", chunkIndex: 0, values: [0, 1] }]),
    ]);
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    await useCase.execute({ request, topics });

    // Two topics, two documents — but each definition is embedded exactly once.
    expect(embedder.calls.sort()).toEqual(
      ["network security controls", "unit price and totals"].sort(),
    );
  });

  it("skips a document with no embeddings shard rather than failing the run", async () => {
    const embedder = new FakeTextEmbedder(definitionVectors);
    // doc-price has no embeddings — an absent overlay is a legitimate outcome.
    const reader = new FakeEmbeddingReader([
      docEmbeddings("doc-sec", [{ chunkId: "doc-sec:0", chunkIndex: 0, values: [1, 0] }]),
    ]);
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    const result = await useCase.execute({ request, topics });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((r) => r.documentId)).toEqual(["doc-sec"]);
  });

  it("refuses to rank chunks whose model differs from the query's", async () => {
    const embedder = new FakeTextEmbedder(definitionVectors);
    // The document declares a different model — its vectors are incomparable.
    const reader = new FakeEmbeddingReader([
      {
        documentId: "doc-sec",
        model: "some-other-model",
        dimensions: 2,
        vectors: [{ chunkId: "doc-sec:0", chunkIndex: 0, values: Float32Array.from([1, 0]) }],
      },
    ]);
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    const result = await useCase.execute({
      request: { ...request, documentIds: ["doc-sec"] },
      topics,
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("propagates a text-embedder failure unchanged", async () => {
    const embedder = new FakeTextEmbedder({}); // no fixture vectors → each embed errors
    const reader = new FakeEmbeddingReader([
      docEmbeddings("doc-sec", [{ chunkId: "doc-sec:0", chunkIndex: 0, values: [1, 0] }]),
    ]);
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    const result = await useCase.execute({
      request: { ...request, documentIds: ["doc-sec"] },
      topics,
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("returns an empty result for a corpus of only shard-less documents", async () => {
    const embedder = new FakeTextEmbedder(definitionVectors);
    const reader = new FakeEmbeddingReader([]); // nothing seeded
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    const result = await useCase.execute({ request, topics });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([]);
  });

  it("returns no rows when the lens has no topics to match against", async () => {
    const embedder = new FakeTextEmbedder(definitionVectors);
    const reader = new FakeEmbeddingReader([
      docEmbeddings("doc-sec", [{ chunkId: "doc-sec:0", chunkIndex: 0, values: [1, 0] }]),
    ]);
    const useCase = new ClassifyByRetrieval({ embeddingReader: reader, textEmbedder: embedder });

    const result = await useCase.execute({
      request: { ...request, documentIds: ["doc-sec"] },
      topics: [],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // No topic embedded, no chunk ranked — nothing to say.
    expect(result.data).toEqual([]);
    expect(embedder.calls).toEqual([]);
  });
});
