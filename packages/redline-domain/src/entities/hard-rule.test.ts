import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import {
  hardRuleSpecificity,
  makeHardRule,
  makeHardRuleSet,
  matchesHardRule,
  type HardRule,
} from "./hard-rule";

const rule = (id: string, pattern: string, topicId = "topic-security"): HardRule => {
  const result = makeHardRule({ id, pattern, topicId });
  if (!isOk(result)) throw new Error("test fixture rule failed to build");
  return result.data;
};

describe("makeHardRule", () => {
  it("builds a rule, trimming id, pattern and topic id", () => {
    const result = makeHardRule({
      id: "  rule-1  ",
      pattern: "  SEC-*  ",
      topicId: "  topic-security  ",
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.id).toBe("rule-1");
    expect(result.data.pattern).toBe("SEC-*");
    expect(result.data.topicId).toBe("topic-security");
  });

  it("collapses a run of wildcards so equivalent patterns are one pattern", () => {
    const result = makeHardRule({ id: "rule-1", pattern: "SEC-***", topicId: "topic-security" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.pattern).toBe("SEC-*");
  });

  it("fails when the id is blank", () => {
    const result = makeHardRule({ id: "   ", pattern: "SEC-*", topicId: "topic-security" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the topic id is blank", () => {
    const result = makeHardRule({ id: "rule-1", pattern: "SEC-*", topicId: "  " });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the pattern is blank", () => {
    const result = makeHardRule({ id: "rule-1", pattern: "  ", topicId: "topic-security" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the pattern pins nothing — a rule may not claim every subject", () => {
    const result = makeHardRule({ id: "rule-1", pattern: "***", topicId: "topic-security" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("matchesHardRule", () => {
  it("matches a wildcard suffix", () => {
    expect(matchesHardRule(rule("rule-1", "SEC-*"), "SEC-014")).toBe(true);
  });

  it("matches the empty run a trailing wildcard allows", () => {
    expect(matchesHardRule(rule("rule-1", "SEC-*"), "SEC-")).toBe(true);
  });

  it("matches a wildcard in the middle of a pattern", () => {
    expect(matchesHardRule(rule("rule-1", "CVE-*-0001"), "CVE-2026-0001")).toBe(true);
  });

  it("matches case-insensitively — identifiers are cased inconsistently across tenders", () => {
    expect(matchesHardRule(rule("rule-1", "SEC-*"), "sec-014")).toBe(true);
  });

  it("anchors the pattern to the whole subject", () => {
    expect(matchesHardRule(rule("rule-1", "SEC-*"), "XSEC-014")).toBe(false);
  });

  it("matches a wildcard-free pattern only against that exact subject", () => {
    const exact = rule("rule-1", "SEC-014");

    expect(matchesHardRule(exact, "SEC-014")).toBe(true);
    expect(matchesHardRule(exact, "SEC-0142")).toBe(false);
  });

  it("treats regex metacharacters in a pattern as literal text", () => {
    const dotted = rule("rule-1", "SEC.*");

    expect(matchesHardRule(dotted, "SEC.014")).toBe(true);
    expect(matchesHardRule(dotted, "SECX014")).toBe(false);
  });

  it("trims the subject before matching", () => {
    expect(matchesHardRule(rule("rule-1", "SEC-*"), "  SEC-014  ")).toBe(true);
  });

  it("does not match a blank subject", () => {
    expect(matchesHardRule(rule("rule-1", "SEC-*"), "   ")).toBe(false);
  });
});

describe("hardRuleSpecificity", () => {
  it("counts the characters a pattern pins", () => {
    expect(hardRuleSpecificity(rule("rule-1", "SEC-*"))).toBe(4);
    expect(hardRuleSpecificity(rule("rule-2", "SEC-CRYPTO-*"))).toBe(11);
  });

  it("scores a wildcard-free pattern by its full length", () => {
    expect(hardRuleSpecificity(rule("rule-1", "SEC-014"))).toBe(7);
  });
});

describe("makeHardRuleSet", () => {
  it("builds a set, preserving declaration order", () => {
    const result = makeHardRuleSet({
      rules: [rule("rule-1", "SEC-*"), rule("rule-2", "CVE-*", "topic-vulnerabilities")],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.rules.map((each) => each.id)).toEqual(["rule-1", "rule-2"]);
  });

  it("accepts an empty set — a lens need not carry hard rules", () => {
    const result = makeHardRuleSet({ rules: [] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.rules).toHaveLength(0);
  });

  it("fails when two rules share an id", () => {
    const result = makeHardRuleSet({ rules: [rule("dup", "SEC-*"), rule("dup", "CVE-*")] });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when two rules carry the same pattern — a duplicate is an authoring error", () => {
    const result = makeHardRuleSet({
      rules: [rule("rule-1", "SEC-*"), rule("rule-2", "sec-*", "topic-vulnerabilities")],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("copies the rules so a later mutation of the caller's array cannot reach the set", () => {
    const callerRules = [rule("rule-1", "SEC-*")];
    const result = makeHardRuleSet({ rules: callerRules });
    callerRules.push(rule("rule-2", "CVE-*"));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.rules).toHaveLength(1);
  });
});
