import { describe, it, expect } from "vitest";
import {
  isOk,
  makeHardRule,
  makeHardRuleSet,
  ok,
  type ClassificationRequest,
  type IProcurementClassifier,
  type RequirementClassification,
  type Result,
} from "@redline/redline-domain";
import { ClassifyWithHardRules } from "./classify-with-hard-rules";

// A classifier fake that records every call. The whole point of the pre-pass is
// that rule-claimed documents never reach it, so "how many times was this
// called, and with which documents" is the assertion the exit test turns on.
class RecordingClassifier implements IProcurementClassifier {
  public calls: ClassificationRequest[] = [];
  constructor(private readonly rows: readonly RequirementClassification[] = []) {}

  classifyResponseGroup(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>> {
    this.calls.push(request);
    return Promise.resolve(ok(this.rows));
  }
}

const ruleSet = () => {
  const security = makeHardRule({ id: "r-sec", pattern: "SEC-*", topicId: "topic-security" });
  const cve = makeHardRule({ id: "r-cve", pattern: "CVE-*", topicId: "topic-vuln" });
  if (!isOk(security) || !isOk(cve)) throw new Error("fixture rules must construct");
  const set = makeHardRuleSet({ rules: [security.data, cve.data] });
  if (!isOk(set)) throw new Error("fixture rule set must construct");
  return set.data;
};

const request: ClassificationRequest = {
  evaluationId: "eval-1",
  responseGroupId: "group-1",
  documentIds: ["doc-sec", "doc-prose"],
};

describe("ClassifyWithHardRules", () => {
  it("resolves rule-claimed documents without ever calling the classifier", async () => {
    const classifier = new RecordingClassifier();
    const useCase = new ClassifyWithHardRules({ classifier });

    const result = await useCase.execute({
      request: {
        evaluationId: "eval-1",
        responseGroupId: "group-1",
        documentIds: ["doc-sec"],
      },
      ruleSet: ruleSet(),
      candidates: [{ documentId: "doc-sec", subjects: ["SEC-014"] }],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // The model port was not engaged at all — every document was claimed.
    expect(classifier.calls).toHaveLength(0);
    expect(result.data).toEqual([
      {
        documentId: "doc-sec",
        requirementId: "topic-security",
        confidence: 1,
        sourceChunkId: null,
      },
    ]);
  });

  it("forwards only the unclaimed documents to the classifier", async () => {
    const classifier = new RecordingClassifier([
      { documentId: "doc-prose", requirementId: "topic-network", confidence: 0.7, sourceChunkId: "c-9" },
    ]);
    const useCase = new ClassifyWithHardRules({ classifier });

    const result = await useCase.execute({
      request,
      ruleSet: ruleSet(),
      candidates: [
        { documentId: "doc-sec", subjects: ["SEC-014"] },
        { documentId: "doc-prose", subjects: ["APP-NOTES"] },
      ],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    // Exactly one call, and it carried only the document no rule claimed.
    expect(classifier.calls).toHaveLength(1);
    expect(classifier.calls[0]?.documentIds).toEqual(["doc-prose"]);

    // The result merges the deterministic claim and the model roll-up.
    expect(result.data).toContainEqual({
      documentId: "doc-sec",
      requirementId: "topic-security",
      confidence: 1,
      sourceChunkId: null,
    });
    expect(result.data).toContainEqual({
      documentId: "doc-prose",
      requirementId: "topic-network",
      confidence: 0.7,
      sourceChunkId: "c-9",
    });
  });

  it("skips the classifier entirely when every document is claimed", async () => {
    const classifier = new RecordingClassifier();
    const useCase = new ClassifyWithHardRules({ classifier });

    const result = await useCase.execute({
      request,
      ruleSet: ruleSet(),
      candidates: [
        { documentId: "doc-sec", subjects: ["SEC-014"] },
        { documentId: "doc-prose", subjects: ["CVE-2026-1"] },
      ],
    });

    expect(isOk(result)).toBe(true);
    expect(classifier.calls).toHaveLength(0);
  });

  it("calls the classifier with the whole group when no rule claims anything", async () => {
    const classifier = new RecordingClassifier();
    const useCase = new ClassifyWithHardRules({ classifier });

    await useCase.execute({
      request,
      ruleSet: ruleSet(),
      candidates: [
        { documentId: "doc-sec", subjects: ["APP-1"] },
        { documentId: "doc-prose", subjects: ["APP-2"] },
      ],
    });

    expect(classifier.calls).toHaveLength(1);
    expect(classifier.calls[0]?.documentIds).toEqual(["doc-sec", "doc-prose"]);
  });

  it("treats a document with no candidate as unclaimed and forwards it", async () => {
    const classifier = new RecordingClassifier();
    const useCase = new ClassifyWithHardRules({ classifier });

    // doc-prose is in the request but has no candidate subjects supplied.
    await useCase.execute({
      request,
      ruleSet: ruleSet(),
      candidates: [{ documentId: "doc-sec", subjects: ["SEC-014"] }],
    });

    expect(classifier.calls).toHaveLength(1);
    expect(classifier.calls[0]?.documentIds).toEqual(["doc-prose"]);
  });

  it("orders the result claimed-first, then the model rows, deterministically", async () => {
    const classifier = new RecordingClassifier([
      { documentId: "doc-prose", requirementId: "topic-network", confidence: 0.7, sourceChunkId: "c-9" },
    ]);
    const useCase = new ClassifyWithHardRules({ classifier });

    const result = await useCase.execute({
      request,
      ruleSet: ruleSet(),
      candidates: [
        { documentId: "doc-sec", subjects: ["SEC-014"] },
        { documentId: "doc-prose", subjects: ["APP-NOTES"] },
      ],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    // The deterministic claim precedes the model roll-up: the pre-pass appends
    // the classifier's rows after the ones it resolved itself.
    expect(result.data.map((row) => row.documentId)).toEqual(["doc-sec", "doc-prose"]);
  });

  it("ignores a candidate for a document not named in the request", async () => {
    const classifier = new RecordingClassifier();
    const useCase = new ClassifyWithHardRules({ classifier });

    const result = await useCase.execute({
      request: {
        evaluationId: "eval-1",
        responseGroupId: "group-1",
        documentIds: ["doc-sec"],
      },
      ruleSet: ruleSet(),
      candidates: [
        { documentId: "doc-sec", subjects: ["SEC-014"] },
        // doc-ghost is not in the request; its candidate must not produce a row.
        { documentId: "doc-ghost", subjects: ["CVE-2026-9"] },
      ],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.documentId)).toEqual(["doc-sec"]);
    expect(classifier.calls).toHaveLength(0);
  });

  it("propagates a classifier failure unchanged", async () => {
    class FailingClassifier implements IProcurementClassifier {
      classifyResponseGroup(): Promise<Result<readonly RequirementClassification[]>> {
        return Promise.resolve({
          error: { code: "CLASSIFICATION_FAILED", message: "numbatch unreachable" },
        });
      }
    }
    const useCase = new ClassifyWithHardRules({ classifier: new FailingClassifier() });

    const result = await useCase.execute({
      request,
      ruleSet: ruleSet(),
      candidates: [{ documentId: "doc-prose", subjects: ["APP-2"] }],
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    expect(result.error.code).toBe("CLASSIFICATION_FAILED");
  });
});
