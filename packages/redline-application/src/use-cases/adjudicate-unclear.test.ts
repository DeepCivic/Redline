import { describe, it, expect } from "vitest";
import {
  isOk,
  ok,
  err,
  domainError,
  type Adjudication,
  type AdjudicationRequest,
  type IAdjudicator,
  type Result,
} from "@redline/redline-domain";
import { AdjudicateUnclear, type UnclearDocument } from "./adjudicate-unclear";

// LLM adjudication — the third leg of the first-pass path (design
// doc §3, "LLM adjudication → clear match + one-sentence rationale"). It runs
// only on what retrieval left genuinely unclear, asks the model to
// choose among the contending topics, and emits a RequirementClassification
// that carries the one-sentence rationale alongside the shared shape.

// A recording fake: it lets each test assert *which documents were adjudicated*
// (the exit test turns on "only the unclear ones reach the model") and lets a
// test drive the chosen topic deterministically.
class RecordingAdjudicator implements IAdjudicator {
  public calls: AdjudicationRequest[] = [];
  constructor(private readonly decide: (req: AdjudicationRequest) => Result<Adjudication>) {}
  adjudicate(request: AdjudicationRequest): Promise<Result<Adjudication>> {
    this.calls.push(request);
    return Promise.resolve(this.decide(request));
  }
}

// The default fake: the document addresses the first candidate only, cited to
// the first passage, rationalised in one sentence.
const chooseFirst = (req: AdjudicationRequest): Result<Adjudication> =>
  ok({
    documentId: req.documentId,
    topics: [
      {
        topicId: req.candidates[0]!.topicId,
        evidenceChunkIds: [req.passages[0]!.chunkId],
        rationale: `${req.candidates[0]!.name} best fits the passages`,
      },
    ],
    exception: null,
    cost: null,
  });

const candidates = [
  { topicId: "topic-security", name: "Security", definition: "network security controls" },
  { topicId: "topic-pricing", name: "Pricing", definition: "unit price and totals" },
] as const;

const request = {
  evaluationId: "eval-1",
  responseGroupId: "group-1",
  documentIds: ["doc-unclear", "doc-other"],
};

const unclearDoc = (documentId: string, chunkIndex = 0): UnclearDocument => ({
  documentId,
  passages: [{ chunkId: `${documentId}:${chunkIndex}`, text: "some ambiguous body text" }],
  candidates,
});

describe("AdjudicateUnclear", () => {
  it("adjudicated assignments carry a rationale", async () => {
    const adjudicator = new RecordingAdjudicator(chooseFirst);
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({
      request,
      unclear: [unclearDoc("doc-unclear")],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const row = result.data[0]!;
    expect(row.rationale).toBe("Security best fits the passages");
    expect(row.requirementId).toBe("topic-security");
    expect(row.documentId).toBe("doc-unclear");
  });

  it("emits the RequirementClassification shape plus a rationale (interchangeable)", async () => {
    const adjudicator = new RecordingAdjudicator(chooseFirst);
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({
      request,
      unclear: [unclearDoc("doc-unclear", 3)],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const row = result.data[0]!;
    // Same keys as RequirementClassification, plus `rationale`. Strip the extra
    // field and a downstream sees exactly the shared shape (D2).
    expect(Object.keys(row).sort()).toEqual(
      ["confidence", "documentId", "rationale", "requirementId", "sourceChunkId", "sourceElementOrder", "unclassified"].sort(),
    );
    // The chosen topic's id is written straight into requirementId (ADR-0010).
    expect(row.requirementId).toBe("topic-security");
    // The chunk the model cited as placing the topic is the row's provenance.
    expect(row.sourceChunkId).toBe("doc-unclear:3");
  });

  it("emits one row per topic the document addresses, each sourced from its own evidence", async () => {
    const adjudicator = new RecordingAdjudicator((req) =>
      ok({
        documentId: req.documentId,
        topics: [
          {
            topicId: "topic-security",
            evidenceChunkIds: ["doc-both:0"],
            rationale: "it describes access controls",
          },
          {
            topicId: "topic-pricing",
            evidenceChunkIds: ["doc-both:1"],
            rationale: "it states a licence fee",
          },
        ],
        exception: null,
        cost: null,
      }),
    );
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({
      request,
      unclear: [
        {
          documentId: "doc-both",
          passages: [
            { chunkId: "doc-both:0", text: "role-based access control" },
            { chunkId: "doc-both:1", text: "$40,000 per annum" },
          ],
          candidates,
        },
      ],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // One model call, two rows — and the rows do not share a source chunk, which
    // is what lets each carry its own summary and deep link.
    expect(adjudicator.calls).toHaveLength(1);
    expect(result.data.map((row) => row.requirementId)).toEqual([
      "topic-security",
      "topic-pricing",
    ]);
    expect(result.data.map((row) => row.sourceChunkId)).toEqual(["doc-both:0", "doc-both:1"]);
  });

  it("emits no rows for a document that addresses none of the candidates", async () => {
    const adjudicator = new RecordingAdjudicator((req) =>
      ok({
        documentId: req.documentId,
        topics: [],
        exception: { documentId: req.documentId, detail: "a covering letter, nothing more" },
        cost: null,
      }),
    );
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({ request, unclear: [unclearDoc("doc-unclear")] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([]);
  });

  it("only adjudicates the documents the caller marked unclear", async () => {
    const adjudicator = new RecordingAdjudicator(chooseFirst);
    const useCase = new AdjudicateUnclear({ adjudicator });

    await useCase.execute({ request, unclear: [unclearDoc("doc-unclear")] });

    // doc-other was in the request but not marked unclear — it never reaches
    // the model (retrieval already settled it, or a hard rule claimed it).
    expect(adjudicator.calls.map((c) => c.documentId)).toEqual(["doc-unclear"]);
  });

  it("returns an empty result and never calls the model when nothing is unclear", async () => {
    const adjudicator = new RecordingAdjudicator(chooseFirst);
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({ request, unclear: [] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([]);
    expect(adjudicator.calls).toHaveLength(0);
  });

  it("adjudicates each unclear document independently", async () => {
    const adjudicator = new RecordingAdjudicator(chooseFirst);
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({
      request,
      unclear: [unclearDoc("doc-a"), unclearDoc("doc-b")],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((r) => r.documentId)).toEqual(["doc-a", "doc-b"]);
    expect(adjudicator.calls).toHaveLength(2);
  });

  it("rejects a verdict that names a topic outside the offered candidates", async () => {
    // A model that hallucinates a topic must not produce a classification —
    // the chosen id has to be one it was offered (the port promises a choice,
    // the use-case enforces it).
    const adjudicator = new RecordingAdjudicator((req) =>
      ok({
        documentId: req.documentId,
        topics: [
          {
            topicId: "topic-invented",
            evidenceChunkIds: [req.passages[0]!.chunkId],
            rationale: "made up",
          },
        ],
        exception: null,
        cost: null,
      }),
    );
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({ request, unclear: [unclearDoc("doc-unclear")] });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("propagates an adjudicator failure unchanged", async () => {
    const adjudicator = new RecordingAdjudicator(() =>
      err(domainError("CLASSIFICATION_FAILED", "model unreachable")),
    );
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({ request, unclear: [unclearDoc("doc-unclear")] });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("rejects an unclear document offering fewer than two candidates", async () => {
    // Adjudication is a choice; with one (or no) candidate there is nothing to
    // adjudicate — that is a caller error, not a silent pass-through.
    const adjudicator = new RecordingAdjudicator(chooseFirst);
    const useCase = new AdjudicateUnclear({ adjudicator });

    const result = await useCase.execute({
      request,
      unclear: [
        {
          documentId: "doc-unclear",
          passages: [{ chunkId: "doc-unclear:0", text: "x" }],
          candidates: [candidates[0]],
        },
      ],
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    // It refuses before spending a model call.
    expect(adjudicator.calls).toHaveLength(0);
  });
});
