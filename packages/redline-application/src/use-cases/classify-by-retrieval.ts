import {
  isErr,
  ok,
  err,
  domainError,
  type ClassificationRequest,
  type DocumentEmbeddings,
  type IEmbeddingReader,
  type ITextEmbedder,
  type QueryEmbedding,
  type RequirementClassification,
  type Result,
  type Topic,
} from "@redline/redline-domain";

// ClassifyByRetrieval — the lens's model-free first-pass classification stage
// (design doc §3, "retrieval → clear match"). For each document it ranks the
// document's chunk vectors against every topic definition's query vector by
// cosine similarity and assigns the document to the best-matching topic. No
// trained Numbatch adapter, no curated samples: this is what makes the workflow
// demonstrable on day one (ADR-0008, D2).
//
// The two vector sources both cross the boundary L2-normalised (ADR-0014), so
// cosine similarity is a plain dot product — no re-normalisation here.
//
// Interchangeability at the port boundary (D2): the rows emitted here are the
// same RequirementClassification the hard-rule pre-pass and the
// Numbatch adapter produce. A topic's id is the requirement's id it
// projects to (ADR-0010), so the matched topic's id is written straight into
// `requirementId` — no mapping table.
//
// This is one leg of §3 — an independent function, composed by the caller, not
// chained to the hard-rule pre-pass or the LLM adjudicator (no orchestrator, D4).
export interface ClassifyByRetrievalDependencies {
  readonly embeddingReader: IEmbeddingReader;
  readonly textEmbedder: ITextEmbedder;
}

export interface ClassifyByRetrievalInput {
  // The response group being classified; `documentIds` is the set to rank.
  readonly request: ClassificationRequest;
  // The lens's topics, each a definition to embed and match against. May be
  // empty — then there is nothing to match and the result is empty.
  readonly topics: readonly Topic[];
}

interface EmbeddedTopic {
  readonly topic: Topic;
  readonly query: QueryEmbedding;
}

interface ChunkMatch {
  readonly requirementId: string;
  readonly confidence: number;
  readonly sourceChunkId: string;
}

// Dot product of two L2-normalised vectors — the cosine similarity (ADR-0014).
// Vectors of different length are caller error caught upstream (model check).
const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
};

export class ClassifyByRetrieval {
  constructor(private readonly dependencies: ClassifyByRetrievalDependencies) {}

  async execute(
    input: ClassifyByRetrievalInput,
  ): Promise<Result<readonly RequirementClassification[]>> {
    // Nothing to match against: no topics means no rows (and no wasted embeds).
    if (input.topics.length === 0) return ok([]);

    // Embed each definition exactly once, up front — a topic's query vector is
    // reused across every document, not re-embedded per document.
    const embedded = await this.embedTopics(input.topics);
    if (isErr(embedded)) return embedded;

    const rows: RequirementClassification[] = [];
    for (const documentId of input.request.documentIds) {
      const read = await this.dependencies.embeddingReader.readEmbeddings(
        input.request.evaluationId,
        documentId,
      );

      // An absent embed stage is a legitimate outcome, not a failed run
      // (ADR-0014, D10): the document is skipped, everything else proceeds.
      if (isErr(read)) {
        if (read.error.code === "NOT_FOUND") continue;
        return err(read.error);
      }

      const matched = this.matchDocument(read.data, embedded.data);
      if (isErr(matched)) return matched;
      if (matched.data) {
        rows.push({
          documentId,
          requirementId: matched.data.requirementId,
          confidence: matched.data.confidence,
          sourceChunkId: matched.data.sourceChunkId,
        });
      }
    }

    return ok(rows);
  }

  private async embedTopics(
    topics: readonly Topic[],
  ): Promise<Result<readonly EmbeddedTopic[]>> {
    const embedded: EmbeddedTopic[] = [];
    for (const topic of topics) {
      const query = await this.dependencies.textEmbedder.embed(topic.definition);
      if (isErr(query)) return err(query.error);
      embedded.push({ topic, query: query.data });
    }
    return ok(embedded);
  }

  // Rank every chunk of one document against every topic's query vector and
  // return the single strongest (topic, chunk) pair. A document is assigned to
  // one requirement here; multi-label splitting is a boundary decision (Thread
  // 27), not a retrieval concern.
  private matchDocument(
    document: DocumentEmbeddings,
    topics: readonly EmbeddedTopic[],
  ): Result<ChunkMatch | null> {
    let best: ChunkMatch | null = null;

    for (const { topic, query } of topics) {
      // Vectors from different models are incomparable — refuse rather than
      // rank noise (ADR-0014). The query and the chunks must share a space.
      if (document.model !== query.model) {
        return err(
          domainError(
            "VALIDATION_FAILED",
            `cannot rank chunks of model '${document.model}' against a query of model '${query.model}'`,
          ),
        );
      }

      for (const chunk of document.vectors) {
        const score = dot(chunk.values, query.values);
        if (best === null || score > best.confidence) {
          best = {
            requirementId: topic.id,
            confidence: score,
            sourceChunkId: chunk.chunkId,
          };
        }
      }
    }

    if (best === null) return ok(null);
    return ok({
      requirementId: best.requirementId,
      confidence: best.confidence,
      sourceChunkId: best.sourceChunkId,
    });
  }
}
