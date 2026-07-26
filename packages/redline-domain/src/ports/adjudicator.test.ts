import { describe, it, expect } from "vitest";
import { isOk, ok, err } from "../result";
import { domainError } from "../errors/domain-error";
import type { AdjudicationCandidate, AdjudicationRequest, IAdjudicator } from "./adjudicator";

// The port is an interface, so the "test" is a conformance check: an in-memory
// fake satisfies the shape, returns a Result — no thrown exceptions cross it —
// and its verdict names one of the offered candidates plus a rationale.
describe("IAdjudicator port", () => {
  const candidates: readonly AdjudicationCandidate[] = [
    { topicId: "topic-security", name: "Security", definition: "network security controls" },
    { topicId: "topic-pricing", name: "Pricing", definition: "unit price and totals" },
  ];

  const request: AdjudicationRequest = {
    documentId: "doc-1",
    passages: ["firewall configuration and access controls"],
    candidates,
  };

  it("is satisfied by an in-memory fake returning a Result", async () => {
    // A fake that picks the first candidate and explains why in one sentence.
    const adjudicator: IAdjudicator = {
      adjudicate: async (req) =>
        ok({
          documentId: req.documentId,
          chosenTopicId: req.candidates[0]!.topicId,
          rationale: `chose ${req.candidates[0]!.name} from ${req.candidates.length} candidates`,
        }),
    };

    const result = await adjudicator.adjudicate(request);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // The verdict names a candidate that was offered, and carries a rationale.
    expect(candidates.map((c) => c.topicId)).toContain(result.data.chosenTopicId);
    expect(result.data.rationale).toContain("2 candidates");
    expect(result.data.documentId).toBe("doc-1");
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
});
