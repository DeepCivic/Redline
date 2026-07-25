import { describe, it, expect } from "vitest";
import { isOk } from "../result";
import { makeHardRule, makeHardRuleSet, type HardRule, type HardRuleSet } from "./hard-rule";
import { evaluateHardRules } from "./hard-rule-evaluation";

const rule = (id: string, pattern: string, topicId: string): HardRule => {
  const result = makeHardRule({ id, pattern, topicId });
  if (!isOk(result)) throw new Error("test fixture rule failed to build");
  return result.data;
};

const ruleSet = (rules: readonly HardRule[]): HardRuleSet => {
  const result = makeHardRuleSet({ rules });
  if (!isOk(result)) throw new Error("test fixture rule set failed to build");
  return result.data;
};

describe("evaluateHardRules", () => {
  it("claims a document for the topic of the rule that matched", () => {
    const outcome = evaluateHardRules({
      ruleSet: ruleSet([rule("rule-1", "SEC-*", "topic-security")]),
      candidate: { documentId: "doc-1", subjects: ["SEC-014"] },
    });

    expect(outcome).toEqual({
      kind: "claimed",
      documentId: "doc-1",
      topicId: "topic-security",
      ruleId: "rule-1",
      matchedSubject: "SEC-014",
    });
  });

  it("leaves a document unclaimed when no rule matches — a gap is not an error", () => {
    const outcome = evaluateHardRules({
      ruleSet: ruleSet([rule("rule-1", "SEC-*", "topic-security")]),
      candidate: { documentId: "doc-1", subjects: ["SUP-002"] },
    });

    expect(outcome).toEqual({ kind: "unclaimed", documentId: "doc-1" });
  });

  it("leaves a document unclaimed when the lens carries no rules", () => {
    const outcome = evaluateHardRules({
      ruleSet: ruleSet([]),
      candidate: { documentId: "doc-1", subjects: ["SEC-014"] },
    });

    expect(outcome).toEqual({ kind: "unclaimed", documentId: "doc-1" });
  });

  it("leaves a document unclaimed when it offers no subjects to match", () => {
    const outcome = evaluateHardRules({
      ruleSet: ruleSet([rule("rule-1", "SEC-*", "topic-security")]),
      candidate: { documentId: "doc-1", subjects: [] },
    });

    expect(outcome).toEqual({ kind: "unclaimed", documentId: "doc-1" });
  });

  it("gives precedence to the more specific pattern when two rules hit", () => {
    const broad = rule("rule-broad", "SEC-*", "topic-security");
    const narrow = rule("rule-narrow", "SEC-CRYPTO-*", "topic-cryptography");
    const candidate = { documentId: "doc-1", subjects: ["SEC-CRYPTO-004"] };

    const outcome = evaluateHardRules({ ruleSet: ruleSet([broad, narrow]), candidate });

    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.ruleId).toBe("rule-narrow");
    expect(outcome.topicId).toBe("topic-cryptography");
  });

  it("gives the more specific pattern precedence whichever order it was declared in", () => {
    const broad = rule("rule-broad", "SEC-*", "topic-security");
    const narrow = rule("rule-narrow", "SEC-CRYPTO-*", "topic-cryptography");
    const candidate = { documentId: "doc-1", subjects: ["SEC-CRYPTO-004"] };

    const narrowFirst = evaluateHardRules({ ruleSet: ruleSet([narrow, broad]), candidate });
    const broadFirst = evaluateHardRules({ ruleSet: ruleSet([broad, narrow]), candidate });

    expect(narrowFirst).toEqual(broadFirst);
  });

  it("gives an exact pattern precedence over any wildcard pattern that also matches", () => {
    const wildcard = rule("rule-wildcard", "SEC-CRYPTO-*", "topic-cryptography");
    const exact = rule("rule-exact", "SEC-CRYPTO-004", "topic-key-management");

    const outcome = evaluateHardRules({
      ruleSet: ruleSet([wildcard, exact]),
      candidate: { documentId: "doc-1", subjects: ["SEC-CRYPTO-004"] },
    });

    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.ruleId).toBe("rule-exact");
  });

  it("breaks a specificity tie on declaration order, so the outcome is deterministic", () => {
    const first = rule("rule-first", "SEC-*", "topic-security");
    const second = rule("rule-second", "*-014", "topic-audit");

    const outcome = evaluateHardRules({
      ruleSet: ruleSet([first, second]),
      candidate: { documentId: "doc-1", subjects: ["SEC-014"] },
    });

    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.ruleId).toBe("rule-first");
  });

  it("weighs rules across every subject the document offers, not just the first", () => {
    const broad = rule("rule-broad", "SUP-*", "topic-support");
    const narrow = rule("rule-narrow", "SEC-CRYPTO-*", "topic-cryptography");

    const outcome = evaluateHardRules({
      ruleSet: ruleSet([broad, narrow]),
      candidate: { documentId: "doc-1", subjects: ["SUP-002", "SEC-CRYPTO-004"] },
    });

    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.ruleId).toBe("rule-narrow");
    expect(outcome.matchedSubject).toBe("SEC-CRYPTO-004");
  });

  it("reports the trimmed subject that matched", () => {
    const outcome = evaluateHardRules({
      ruleSet: ruleSet([rule("rule-1", "SEC-*", "topic-security")]),
      candidate: { documentId: "doc-1", subjects: ["  SEC-014  "] },
    });

    expect(outcome.kind).toBe("claimed");
    if (outcome.kind !== "claimed") return;
    expect(outcome.matchedSubject).toBe("SEC-014");
  });

  it("is pure — repeated evaluation returns the same outcome and mutates no input", () => {
    const rules = ruleSet([rule("rule-1", "SEC-*", "topic-security")]);
    const candidate = { documentId: "doc-1", subjects: ["SEC-014"] };

    const first = evaluateHardRules({ ruleSet: rules, candidate });
    const second = evaluateHardRules({ ruleSet: rules, candidate });

    expect(first).toEqual(second);
    expect(rules.rules.map((each) => each.id)).toEqual(["rule-1"]);
    expect(candidate.subjects).toEqual(["SEC-014"]);
  });
});
