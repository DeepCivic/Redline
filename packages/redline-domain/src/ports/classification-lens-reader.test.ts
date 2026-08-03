import { describe, it, expect } from "vitest";
import { isErr, isOk, ok, err } from "../result";
import { domainError } from "../errors/domain-error";
import { makeHardRuleSet } from "../entities/hard-rule";
import type { Topic } from "../entities/topic";
import type {
  ClassificationLensRequest,
  IClassificationLensReader,
} from "./classification-lens-reader";

// The port is an interface, so the "test" is a conformance check: an in-memory
// fake satisfies the shape, returns a Result — no thrown exceptions cross it —
// and the lens it returns is scoped to the request's evaluation, with candidates
// derived from the request's documentIds.

const topics: readonly Topic[] = [
  { id: "topic-security", name: "Security", definition: "network security controls" },
  { id: "topic-pricing", name: "Pricing", definition: "unit price and totals" },
];

const ruleSet = () => {
  const set = makeHardRuleSet({ rules: [{ id: "r1", pattern: "SEC-*", topicId: "topic-security" }] });
  if (isErr(set)) throw new Error("bad rule set");
  return set.data;
};

const request: ClassificationLensRequest = {
  evaluationId: "eval-1",
  documentIds: ["SEC-014", "doc-2"],
};

describe("IClassificationLensReader port", () => {
  it("is satisfied by an in-memory fake returning a Result", async () => {
    const reader: IClassificationLensReader = {
      readLens: async (input) =>
        ok({
          topics,
          ruleSet: ruleSet(),
          // Candidates are derived per document from the request's documentIds:
          // identifier tokens, never prose.
          candidates: input.documentIds.map((documentId) => ({
            documentId,
            subjects: [documentId],
          })),
        }),
    };

    const result = await reader.readLens(request);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.topics.map((topic) => topic.id)).toEqual([
      "topic-security",
      "topic-pricing",
    ]);
    expect(result.data.ruleSet.rules).toHaveLength(1);
    // One candidate per requested document, in request order.
    expect(result.data.candidates.map((candidate) => candidate.documentId)).toEqual([
      "SEC-014",
      "doc-2",
    ]);
  });

  it("returns different lenses for different evaluations", async () => {
    const byEvaluation = new Map<string, readonly Topic[]>([
      ["eval-1", [topics[0]!]],
      ["eval-2", [topics[1]!]],
    ]);

    const reader: IClassificationLensReader = {
      readLens: async (input) => {
        const forEvaluation = byEvaluation.get(input.evaluationId);
        if (!forEvaluation) {
          return err(domainError("NOT_FOUND", `no lens bound to evaluation '${input.evaluationId}'`));
        }
        return ok({ topics: forEvaluation, ruleSet: ruleSet(), candidates: [] });
      },
    };

    const first = await reader.readLens({ evaluationId: "eval-1", documentIds: [] });
    const second = await reader.readLens({ evaluationId: "eval-2", documentIds: [] });

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.data.topics[0]!.id).toBe("topic-security");
    expect(second.data.topics[0]!.id).toBe("topic-pricing");
  });

  it("returns a Result error rather than throwing when no lens is bound", async () => {
    const reader: IClassificationLensReader = {
      readLens: async () => err(domainError("NOT_FOUND", "no lens bound to this evaluation")),
    };

    const result = await reader.readLens(request);

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});
