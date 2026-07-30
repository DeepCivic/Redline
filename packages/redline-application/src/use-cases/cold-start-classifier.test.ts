import { describe, it, expect } from "vitest";
import {
  domainError,
  err,
  isErr,
  isOk,
  ok,
  makeHardRuleSet,
  type Adjudication,
  type AdjudicationRequest,
  type ChunkRow,
  type IAdjudicator,
  type IChunkStore,
  type IProcurementClassifier,
  type Result,
  type ScoredChunkRef,
  type StructureFilter,
  type Topic,
} from "@redline/redline-domain";
import { ColdStartClassifier } from "./cold-start-classifier";

// Item 1b's exit test. The cold-start IProcurementClassifier runs ADR-0008's
// untrained first pass with the ADR-0018-addendum shape: hard rules + LLM
// adjudication over *exact/structural* fetch — no nearest-neighbour placing,
// because vector similarity search is deferred. The assertions turn on:
//   - a hard-rule-claimed document never reaches the store or the model;
//   - an unclaimed document's passages come from fetchByStructure (exact fetch),
//     and the adjudicator's chosen topic becomes the requirementId;
//   - findSimilar is never called — the class must not depend on the deferred
//     nearest-neighbour step;
//   - the output is RequirementClassification[], interchangeable with every
//     other path (a downstream cannot tell which ran).

const topic = (id: string, name: string): Topic => ({
  id,
  name,
  definition: `definition of ${name}`,
});

const chunk = (over: Partial<ChunkRow> & Pick<ChunkRow, "chunkId" | "chunkIndex">): ChunkRow => ({
  documentId: "doc-1",
  contentType: "narrative",
  page: null,
  text: "a verbatim passage",
  ...over,
});

// A store that records how it was queried and refuses the deferred half. Seeded
// per document; fetchByStructure returns the document's rows in chunkIndex order.
class RecordingChunkStore implements IChunkStore {
  public structureCalls: StructureFilter[] = [];
  public findSimilarCalls = 0;
  private readonly byDocument = new Map<string, ChunkRow[]>();

  seed(documentId: string, rows: readonly ChunkRow[]): void {
    this.byDocument.set(documentId, [...rows]);
  }

  async fetchChunks(
    _evaluationId: string,
    chunkIds: readonly string[],
  ): Promise<Result<readonly ChunkRow[]>> {
    const all = [...this.byDocument.values()].flat();
    return ok(
      chunkIds
        .map((id) => all.find((r) => r.chunkId === id))
        .filter((r): r is ChunkRow => r !== undefined),
    );
  }

  async fetchByStructure(
    _evaluationId: string,
    filter: StructureFilter,
  ): Promise<Result<readonly ChunkRow[]>> {
    this.structureCalls.push(filter);
    const rows = filter.documentId ? (this.byDocument.get(filter.documentId) ?? []) : [];
    return ok([...rows].sort((a, b) => a.chunkIndex - b.chunkIndex));
  }

  async findSimilar(): Promise<Result<readonly ScoredChunkRef[]>> {
    this.findSimilarCalls += 1;
    return err(domainError("NOT_IMPLEMENTED", "deferred (ADR-0018 addendum)"));
  }
}

// An adjudicator that records the passages it was handed and returns a fixed
// verdict. The test asserts the passages are the store's verbatim chunk text.
class RecordingAdjudicator implements IAdjudicator {
  public requests: AdjudicationRequest[] = [];
  constructor(private readonly chosenTopicId: string) {}
  async adjudicate(request: AdjudicationRequest) {
    this.requests.push(request);
    const verdict: Adjudication = {
      documentId: request.documentId,
      chosenTopicId: this.chosenTopicId,
      rationale: "the passage speaks to this topic",
    };
    return ok(verdict);
  }
}

const topics = [topic("req-support", "Support"), topic("req-hosting", "Hosting")];

const emptyRules = () => {
  const set = makeHardRuleSet({ rules: [] });
  if (isErr(set)) throw new Error("bad rule set");
  return set.data;
};

describe("ColdStartClassifier — untrained first pass over the store (ADR-0008 / ADR-0018)", () => {
  it("satisfies IProcurementClassifier", () => {
    const store = new RecordingChunkStore();
    const classifier: IProcurementClassifier = new ColdStartClassifier({
      chunkStore: store,
      adjudicator: new RecordingAdjudicator("req-support"),
      topics,
      ruleSet: emptyRules(),
      candidates: [],
    });
    expect(typeof classifier.classifyResponseGroup).toBe("function");
  });

  it("adjudicates an unclaimed document over passages fetched by structure — no similarity search", async () => {
    const store = new RecordingChunkStore();
    store.seed("doc-1", [
      chunk({ chunkId: "doc-1:0", chunkIndex: 0, text: "we provide 24/7 support" }),
      chunk({ chunkId: "doc-1:1", chunkIndex: 1, text: "and a helpdesk" }),
    ]);
    const adjudicator = new RecordingAdjudicator("req-support");

    const classifier = new ColdStartClassifier({
      chunkStore: store,
      adjudicator,
      topics,
      ruleSet: emptyRules(),
      candidates: [],
    });

    const result = await classifier.classifyResponseGroup({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["doc-1"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      documentId: "doc-1",
      requirementId: "req-support",
      confidence: 1,
      sourceChunkId: "doc-1:0",
    });

    // Passages came from the store's verbatim chunk text, in order.
    expect(adjudicator.requests).toHaveLength(1);
    expect(adjudicator.requests[0].passages).toEqual(["we provide 24/7 support", "and a helpdesk"]);
    // The candidates offered were the lens topics.
    expect(adjudicator.requests[0].candidates.map((c) => c.topicId)).toEqual([
      "req-support",
      "req-hosting",
    ]);

    // The exact-fetch half was used; the deferred nearest-neighbour step was not.
    expect(store.structureCalls).toEqual([{ documentId: "doc-1" }]);
    expect(store.findSimilarCalls).toBe(0);
  });

  it("resolves a hard-rule-claimed document deterministically — never touching store or model", async () => {
    const store = new RecordingChunkStore();
    // Seed chunks that would exist, to prove they are never read for a claimed doc.
    store.seed("SEC-014", [chunk({ documentId: "SEC-014", chunkId: "SEC-014:0", chunkIndex: 0 })]);
    const adjudicator = new RecordingAdjudicator("req-hosting");

    const ruleSet = makeHardRuleSet({
      rules: [{ id: "r1", pattern: "SEC-*", topicId: "req-support" }],
    });
    if (isErr(ruleSet)) throw new Error("bad rule set");

    const classifier = new ColdStartClassifier({
      chunkStore: store,
      adjudicator,
      topics,
      ruleSet: ruleSet.data,
      candidates: [{ documentId: "SEC-014", subjects: ["SEC-014"] }],
    });

    const result = await classifier.classifyResponseGroup({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["SEC-014"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]).toMatchObject({
      documentId: "SEC-014",
      requirementId: "req-support",
      confidence: 1,
      sourceChunkId: null,
    });
    // A rule claim is a certainty: no store read, no model call.
    expect(store.structureCalls).toEqual([]);
    expect(store.findSimilarCalls).toBe(0);
    expect(adjudicator.requests).toEqual([]);
  });

  it("skips a document the store has no chunks for (absent extraction, not a failed run)", async () => {
    const store = new RecordingChunkStore(); // doc-1 not seeded
    const adjudicator = new RecordingAdjudicator("req-support");

    const classifier = new ColdStartClassifier({
      chunkStore: store,
      adjudicator,
      topics,
      ruleSet: emptyRules(),
      candidates: [],
    });

    const result = await classifier.classifyResponseGroup({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["doc-1"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([]);
    // No passages, so the model is never asked to adjudicate nothing.
    expect(adjudicator.requests).toEqual([]);
  });

  it("refuses to adjudicate when fewer than two topics are in contention", async () => {
    const store = new RecordingChunkStore();
    store.seed("doc-1", [chunk({ chunkId: "doc-1:0", chunkIndex: 0 })]);

    const classifier = new ColdStartClassifier({
      chunkStore: store,
      adjudicator: new RecordingAdjudicator("only"),
      topics: [topic("only", "Only")],
      ruleSet: emptyRules(),
      candidates: [],
    });

    const result = await classifier.classifyResponseGroup({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["doc-1"],
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("propagates a store failure unchanged", async () => {
    class FailingStore extends RecordingChunkStore {
      override async fetchByStructure(
        _e: string,
        filter: StructureFilter,
      ): Promise<Result<readonly ChunkRow[]>> {
        this.structureCalls.push(filter);
        return err(domainError("INFRA_FAILURE", "store down"));
      }
    }
    const store = new FailingStore();
    const classifier = new ColdStartClassifier({
      chunkStore: store,
      adjudicator: new RecordingAdjudicator("req-support"),
      topics,
      ruleSet: emptyRules(),
      candidates: [],
    });

    const result = await classifier.classifyResponseGroup({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["doc-1"],
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });
});
