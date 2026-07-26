import { describe, it, expect } from "vitest";
import { deriveComprehension, type ComprehensionInput } from "./ambiguity-derivation";

const doc = (documentId: string, ...scores: readonly number[]): ComprehensionInput => ({
  documentId,
  candidates: scores.map((score, index) => ({ topicId: `topic-${index}`, score })),
});

describe("deriveComprehension", () => {
  it("buckets a single strong leader as Clear", () => {
    const result = deriveComprehension(doc("doc-1", 0.88, 0.2));
    expect(result.documentId).toBe("doc-1");
    expect(result.bucket).toBe("clear");
    expect(result.firedSignals).toEqual([]);
  });

  it("buckets close contenders as Ambiguous and names the signal that fired", () => {
    const result = deriveComprehension(doc("doc-1", 0.71, 0.69));
    expect(result.bucket).toBe("ambiguous");
    expect(result.firedSignals).toContain("close-contenders");
  });

  it("buckets a document nothing scored as Ambiguous", () => {
    const result = deriveComprehension(doc("doc-1"));
    expect(result.bucket).toBe("ambiguous");
    expect(result.firedSignals).toContain("no-clear-leader");
  });

  it("buckets a weak leader as Ambiguous", () => {
    const result = deriveComprehension(doc("doc-1", 0.2));
    expect(result.bucket).toBe("ambiguous");
    expect(result.firedSignals).toContain("no-clear-leader");
  });

  it("reports every signal that fired, not just the first", () => {
    // A weak leader AND a close runner-up: both implemented signals fire.
    const result = deriveComprehension(doc("doc-1", 0.2, 0.19));
    expect(result.bucket).toBe("ambiguous");
    expect(result.firedSignals).toEqual(
      expect.arrayContaining(["no-clear-leader", "close-contenders"]),
    );
  });

  it("reports fired signals in register order — deterministic", () => {
    const result = deriveComprehension(doc("doc-1", 0.2, 0.19));
    // no-clear-leader precedes close-contenders in the register.
    expect(result.firedSignals).toEqual(["no-clear-leader", "close-contenders"]);
  });

  it("is Ambiguous iff at least one implemented signal fires", () => {
    expect(deriveComprehension(doc("doc-1", 0.9, 0.1)).bucket).toBe("clear");
    expect(deriveComprehension(doc("doc-1", 0.5, 0.49)).bucket).toBe("ambiguous");
  });

  // The load-bearing invariant of this thread (exit criterion; non-goal §8): a
  // confidence value never escapes to the view model. The derivation *reads*
  // scores and emits only a bucket + the ids of the signals that fired.
  it("lets no confidence value escape — the output carries only a bucket and signal ids", () => {
    const result = deriveComprehension(doc("doc-1", 0.71, 0.69));
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("0.71");
    expect(serialised).not.toContain("0.69");
    expect(serialised).not.toContain("score");
    expect(serialised).not.toContain("confidence");
    // Structurally: the keys are exactly the three the view model may see.
    expect(Object.keys(result).sort()).toEqual(["bucket", "documentId", "firedSignals"]);
  });

  it("is pure — repeated derivation returns the same result and mutates no input", () => {
    const input = doc("doc-1", 0.71, 0.69);
    const snapshot = JSON.parse(JSON.stringify(input));
    const first = deriveComprehension(input);
    const second = deriveComprehension(input);
    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
  });
});
