import { describe, it, expect } from "vitest";
import { isOk, ok, err } from "../result";
import { domainError } from "../errors/domain-error";
import type {
  Adjudication,
  AdjudicationCandidate,
  AdjudicationPassage,
  AdjudicationRequest,
  IAdjudicator,
} from "./adjudicator";

// The port is an interface, so the "test" is a conformance check: an in-memory
// fake satisfies the shape, returns a Result — no thrown exceptions cross it —
// and its verdict names the topics the document addresses, each with the chunks
// that placed it. The three behaviours the shape has to make expressible are
// asserted here, because a caller writing against the port is entitled to rely
// on them: many topics from one call, evidence per topic, and an empty set that
// arrives as an exception rather than as silence.
describe("IAdjudicator port", () => {
  const candidates: readonly AdjudicationCandidate[] = [
    { topicId: "topic-security", name: "Security", definition: "network security controls" },
    { topicId: "topic-pricing", name: "Pricing", definition: "unit price and totals" },
    { topicId: "topic-support", name: "Support", definition: "helpdesk and response times" },
  ];

  const passages: readonly AdjudicationPassage[] = [
    { chunkId: "doc-1:0", text: "firewall configuration and access controls" },
    { chunkId: "doc-1:1", text: "the annual licence is $40,000 excluding GST" },
  ];

  const request: AdjudicationRequest = { documentId: "doc-1", passages, candidates };

  it("carries every topic the document addresses, each naming the chunks that placed it", async () => {
    // A fake that reads two of the three candidates out of the passages it was
    // given, and cites the passage that carried each.
    const adjudicator: IAdjudicator = {
      adjudicate: async (req) =>
        ok({
          documentId: req.documentId,
          topics: [
            {
              topicId: "topic-security",
              evidenceChunkIds: [req.passages[0]!.chunkId],
              rationale: "the passage describes firewall and access controls",
            },
            {
              topicId: "topic-pricing",
              evidenceChunkIds: [req.passages[1]!.chunkId],
              rationale: "the passage states an annual licence fee",
            },
          ],
          exception: null,
          cost: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 },
        }),
    };

    const result = await adjudicator.adjudicate(request);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.topics.map((topic) => topic.topicId)).toEqual([
      "topic-security",
      "topic-pricing",
    ]);
    // Every returned topic was offered, and every topic carries evidence.
    const offeredTopicIds = candidates.map((candidate) => candidate.topicId);
    for (const topic of result.data.topics) {
      expect(offeredTopicIds).toContain(topic.topicId);
      expect(topic.evidenceChunkIds.length).toBeGreaterThan(0);
    }
    // The evidence differs per topic — that is what lets a row summarise and
    // deep-link to its own passage rather than to the document's first chunk.
    expect(result.data.topics[0]!.evidenceChunkIds).not.toEqual(
      result.data.topics[1]!.evidenceChunkIds,
    );
    expect(result.data.exception).toBeNull();
  });

  it("reports the token cost of the one call it made", async () => {
    const adjudicator: IAdjudicator = {
      adjudicate: async (req) =>
        ok({
          documentId: req.documentId,
          topics: [
            {
              topicId: "topic-security",
              evidenceChunkIds: ["doc-1:0"],
              rationale: "controls",
            },
          ],
          exception: null,
          cost: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 },
        }),
    };

    const result = await adjudicator.adjudicate(request);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.cost).toEqual({
      promptTokens: 900,
      completionTokens: 120,
      totalTokens: 1020,
    });
  });

  it("reports a document that addresses no topic as an exception, not as an absence", async () => {
    // The verdict is a success — the model read the document and found nothing
    // the lens asks about. Left as a bare empty array a caller could skip it
    // silently, and the document would vanish from the evaluation.
    const adjudicator: IAdjudicator = {
      adjudicate: async (req) =>
        ok({
          documentId: req.documentId,
          topics: [],
          exception: {
            documentId: req.documentId,
            detail: "the passages are a covering letter and address none of the candidate topics",
          },
          cost: null,
        }),
    };

    const result = await adjudicator.adjudicate(request);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.topics).toEqual([]);
    expect(result.data.exception?.documentId).toBe("doc-1");
    expect(result.data.exception?.detail).toContain("covering letter");
  });

  it("returns a Result error rather than throwing when it cannot decide", async () => {
    const adjudicator: IAdjudicator = {
      adjudicate: async () => err(domainError("CLASSIFICATION_FAILED", "model unreachable")),
    };

    const result = await adjudicator.adjudicate(request);

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });

  it("holds the invariant that an exception and an empty topic set travel together", () => {
    // The shape permits both fields, so the contract is what ties them: a
    // verdict with topics carries no exception, and one without topics does.
    const addressed: Adjudication = {
      documentId: "doc-1",
      topics: [{ topicId: "topic-support", evidenceChunkIds: ["doc-1:0"], rationale: "helpdesk" }],
      exception: null,
      cost: null,
    };
    const addressedNothing: Adjudication = {
      documentId: "doc-2",
      topics: [],
      exception: { documentId: "doc-2", detail: "nothing in the lens" },
      cost: null,
    };

    expect(addressed.topics.length > 0).toBe(addressed.exception === null);
    expect(addressedNothing.topics.length === 0).toBe(addressedNothing.exception !== null);
  });
});
