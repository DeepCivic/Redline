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
  type ClassificationLens,
  type ClassificationLensRequest,
  type HardRuleCandidate,
  type HardRuleSet,
  type IAdjudicator,
  type IChunkStore,
  type IClassificationLensReader,
  type IProcurementClassifier,
  type Result,
  type ScoredChunkRef,
  type StructureFilter,
  type Topic,
} from "@redline/redline-domain";
import { ColdStartClassifier } from "./cold-start-classifier";

// The cold-start IProcurementClassifier runs ADR-0008's untrained first pass in
// the ADR-0018-addendum shape: hard rules + LLM adjudication over
// *exact/structural* fetch — no nearest-neighbour placing, because vector
// similarity search is deferred. The assertions turn on:
//   - the lens is resolved per call through IClassificationLensReader, so one
//     instance serves every evaluation in the process (delivery-plan item 1);
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

// A verdict naming one topic, cited to the first passage the model was given —
// the shape the fakes below return. Building it here keeps each fake to the one
// thing it varies.
const verdictFor = (request: AdjudicationRequest, topicId: string): Adjudication => ({
  documentId: request.documentId,
  topics: [
    {
      topicId,
      evidenceChunkIds: [request.passages[0]!.chunkId],
      rationale: "the passage speaks to this topic",
    },
  ],
  exception: null,
  cost: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
});

// An adjudicator that records the passages it was handed and returns a fixed
// verdict. The test asserts the passages are the store's verbatim chunk text,
// each addressed by the chunk it came from.
class RecordingAdjudicator implements IAdjudicator {
  public requests: AdjudicationRequest[] = [];
  constructor(private readonly chosenTopicId: string) {}
  async adjudicate(request: AdjudicationRequest) {
    this.requests.push(request);
    return ok(verdictFor(request, this.chosenTopicId));
  }
}

// An adjudicator that echoes back whichever candidate it was offered first, so a
// test can prove *which lens* reached the model rather than a fixed answer.
class FirstCandidateAdjudicator implements IAdjudicator {
  public requests: AdjudicationRequest[] = [];
  async adjudicate(request: AdjudicationRequest) {
    this.requests.push(request);
    return ok(verdictFor(request, request.candidates[0]!.topicId));
  }
}

// An adjudicator whose verdict is that the document addresses nothing in the
// lens — a legitimate outcome, reported as an exception.
class AddressesNothingAdjudicator implements IAdjudicator {
  public requests: AdjudicationRequest[] = [];
  async adjudicate(request: AdjudicationRequest) {
    this.requests.push(request);
    const verdict: Adjudication = {
      documentId: request.documentId,
      topics: [],
      exception: { documentId: request.documentId, detail: "a covering letter, nothing more" },
      cost: null,
    };
    return ok(verdict);
  }
}

// The lens reader the classifier resolves its evaluation context through. Binds
// a lens per evaluation, so one classifier instance can be asked about two.
class FakeLensReader implements IClassificationLensReader {
  public requests: ClassificationLensRequest[] = [];
  private readonly byEvaluation = new Map<string, ClassificationLens>();

  bind(evaluationId: string, lens: ClassificationLens): void {
    this.byEvaluation.set(evaluationId, lens);
  }

  async readLens(request: ClassificationLensRequest): Promise<Result<ClassificationLens>> {
    this.requests.push(request);
    const lens = this.byEvaluation.get(request.evaluationId);
    if (!lens) {
      return err(domainError("NOT_FOUND", `no lens bound to evaluation '${request.evaluationId}'`));
    }
    return ok(lens);
  }
}

const topics = [topic("req-support", "Support"), topic("req-hosting", "Hosting")];

const emptyRules = (): HardRuleSet => {
  const set = makeHardRuleSet({ rules: [] });
  if (isErr(set)) throw new Error("bad rule set");
  return set.data;
};

// A reader bound to one evaluation ("e1"), the shape most cases need.
const readerFor = (lens: Partial<ClassificationLens> = {}): FakeLensReader => {
  const reader = new FakeLensReader();
  reader.bind("e1", {
    topics,
    ruleSet: emptyRules(),
    candidates: [],
    ...lens,
  });
  return reader;
};

describe("ColdStartClassifier — untrained first pass over the store (ADR-0008 / ADR-0018)", () => {
  it("satisfies IProcurementClassifier", () => {
    const classifier: IProcurementClassifier = new ColdStartClassifier({
      chunkStore: new RecordingChunkStore(),
      adjudicator: new RecordingAdjudicator("req-support"),
      lensReader: readerFor(),
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
    const lensReader = readerFor();

    const classifier = new ColdStartClassifier({ chunkStore: store, adjudicator, lensReader });

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

    // The lens was resolved for this evaluation, carrying the documents in play.
    expect(lensReader.requests).toEqual([{ evaluationId: "e1", documentIds: ["doc-1"] }]);

    // Passages came from the store's verbatim chunk text, in order, each
    // addressed by its chunk id so the verdict can cite the chunk that placed it.
    expect(adjudicator.requests).toHaveLength(1);
    expect(adjudicator.requests[0].passages).toEqual([
      { chunkId: "doc-1:0", text: "we provide 24/7 support" },
      { chunkId: "doc-1:1", text: "and a helpdesk" },
    ]);
    // The candidates offered were the lens topics.
    expect(adjudicator.requests[0].candidates.map((c) => c.topicId)).toEqual([
      "req-support",
      "req-hosting",
    ]);

    // The exact-fetch half was used; the deferred nearest-neighbour step was not.
    expect(store.structureCalls).toEqual([{ documentId: "doc-1" }]);
    expect(store.findSimilarCalls).toBe(0);
  });

  it("classifies two evaluations against their own lenses from one instance", async () => {
    // The exit test: the classifier is constructed once, with no lens of its own,
    // and serves two evaluations — the shape the fork's process-wide memoised
    // getContainer() forces (delivery-plan item 1).
    const store = new RecordingChunkStore();
    store.seed("doc-a", [chunk({ documentId: "doc-a", chunkId: "doc-a:0", chunkIndex: 0 })]);
    store.seed("doc-b", [chunk({ documentId: "doc-b", chunkId: "doc-b:0", chunkIndex: 0 })]);

    const councilTopics = [topic("req-support", "Support"), topic("req-hosting", "Hosting")];
    const hospitalTopics = [topic("req-clinical", "Clinical"), topic("req-training", "Training")];

    const lensReader = new FakeLensReader();
    lensReader.bind("council-tender", {
      topics: councilTopics,
      ruleSet: emptyRules(),
      candidates: [],
    });
    lensReader.bind("hospital-tender", {
      topics: hospitalTopics,
      ruleSet: emptyRules(),
      candidates: [],
    });

    const adjudicator = new FirstCandidateAdjudicator();
    const classifier = new ColdStartClassifier({ chunkStore: store, adjudicator, lensReader });

    const council = await classifier.classifyResponseGroup({
      evaluationId: "council-tender",
      responseGroupId: "group-a",
      documentIds: ["doc-a"],
    });
    const hospital = await classifier.classifyResponseGroup({
      evaluationId: "hospital-tender",
      responseGroupId: "group-b",
      documentIds: ["doc-b"],
    });

    expect(isOk(council)).toBe(true);
    expect(isOk(hospital)).toBe(true);
    if (!isOk(council) || !isOk(hospital)) return;

    // Each group came back with its own evaluation's topics.
    expect(council.data[0]!.requirementId).toBe("req-support");
    expect(hospital.data[0]!.requirementId).toBe("req-clinical");

    // And each adjudication was offered only its own lens's candidates.
    expect(adjudicator.requests[0]!.candidates.map((c) => c.topicId)).toEqual([
      "req-support",
      "req-hosting",
    ]);
    expect(adjudicator.requests[1]!.candidates.map((c) => c.topicId)).toEqual([
      "req-clinical",
      "req-training",
    ]);
  });

  it("applies each evaluation's own hard rules", async () => {
    // The rule half of the same isolation: the same document identifier is
    // claimed by one evaluation's rules and not the other's.
    const store = new RecordingChunkStore();
    store.seed("SEC-014", [chunk({ documentId: "SEC-014", chunkId: "SEC-014:0", chunkIndex: 0 })]);

    const strictRules = makeHardRuleSet({
      rules: [{ id: "r1", pattern: "SEC-*", topicId: "req-hosting" }],
    });
    if (isErr(strictRules)) throw new Error("bad rule set");

    const candidates: readonly HardRuleCandidate[] = [
      { documentId: "SEC-014", subjects: ["SEC-014"] },
    ];

    const lensReader = new FakeLensReader();
    lensReader.bind("ruled", { topics, ruleSet: strictRules.data, candidates });
    lensReader.bind("unruled", { topics, ruleSet: emptyRules(), candidates });

    const adjudicator = new RecordingAdjudicator("req-support");
    const classifier = new ColdStartClassifier({ chunkStore: store, adjudicator, lensReader });

    const ruled = await classifier.classifyResponseGroup({
      evaluationId: "ruled",
      responseGroupId: "g1",
      documentIds: ["SEC-014"],
    });
    const unruled = await classifier.classifyResponseGroup({
      evaluationId: "unruled",
      responseGroupId: "g2",
      documentIds: ["SEC-014"],
    });

    expect(isOk(ruled)).toBe(true);
    expect(isOk(unruled)).toBe(true);
    if (!isOk(ruled) || !isOk(unruled)) return;

    // Claimed by the rule: deterministic, no source chunk, model never asked.
    expect(ruled.data[0]).toMatchObject({ requirementId: "req-hosting", sourceChunkId: null });
    // No rule in the other lens: it fell through to adjudication.
    expect(unruled.data[0]).toMatchObject({
      requirementId: "req-support",
      sourceChunkId: "SEC-014:0",
    });
    expect(adjudicator.requests).toHaveLength(1);
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
      lensReader: readerFor({
        ruleSet: ruleSet.data,
        candidates: [{ documentId: "SEC-014", subjects: ["SEC-014"] }],
      }),
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
      lensReader: readerFor(),
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

  it("emits no row for a document the adjudicator says addresses no topic", async () => {
    const store = new RecordingChunkStore();
    store.seed("doc-1", [chunk({ chunkId: "doc-1:0", chunkIndex: 0 })]);
    const adjudicator = new AddressesNothingAdjudicator();

    const classifier = new ColdStartClassifier({
      chunkStore: store,
      adjudicator,
      lensReader: readerFor(),
    });

    const result = await classifier.classifyResponseGroup({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["doc-1"],
    });

    // The document was read and adjudicated — it simply matched nothing, which
    // is a verdict, not a failure. Carrying that exception on to a surface a
    // specialist looks at is delivery-plan item 2's job, not this port's.
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([]);
    expect(adjudicator.requests).toHaveLength(1);
  });

  it("refuses to adjudicate when fewer than two topics are in contention", async () => {
    const store = new RecordingChunkStore();
    store.seed("doc-1", [chunk({ chunkId: "doc-1:0", chunkIndex: 0 })]);

    const classifier = new ColdStartClassifier({
      chunkStore: store,
      adjudicator: new RecordingAdjudicator("only"),
      lensReader: readerFor({ topics: [topic("only", "Only")] }),
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

  it("propagates a lens-reader failure unchanged", async () => {
    const classifier = new ColdStartClassifier({
      chunkStore: new RecordingChunkStore(),
      adjudicator: new RecordingAdjudicator("req-support"),
      // Nothing bound for "e1": no lens reaches this evaluation.
      lensReader: new FakeLensReader(),
    });

    const result = await classifier.classifyResponseGroup({
      evaluationId: "e1",
      responseGroupId: "g1",
      documentIds: ["doc-1"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
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
      lensReader: readerFor(),
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
