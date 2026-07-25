import { domainError } from "../errors/domain-error";
import { err, ok, type Result } from "../result";

// `*` is the only metacharacter a hard-rule pattern has: it stands for any run
// of characters, and every other character is literal. Anything richer would be
// a regex, and the specialist authoring rules against a tender is not writing
// regexes.
const WILDCARD = "*";

const literalLength = (pattern: string): number => pattern.split(WILDCARD).join("").length;

const escapeRegExp = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const patternToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split(WILDCARD).map(escapeRegExp).join(".*")}$`, "iu");

// A deterministic pattern -> topic assignment that resolves before any model
// runs (design doc §3, "hard rules -> assigned"). Direct precedent: womblex's
// register ingests bypass the NLP pipeline by design.
//
// `topicId` is a plain reference, not a `Topic`: a rule is authored against a
// lens the domain need not hold to evaluate the rule, and the lens binding
// arrives with persistence.
export interface HardRule {
  readonly id: string;
  readonly pattern: string;
  readonly topicId: string;
}

export interface MakeHardRuleInput {
  readonly id: string;
  readonly pattern: string;
  readonly topicId: string;
}

export const makeHardRule = (input: MakeHardRuleInput): Result<HardRule> => {
  const id = input.id.trim();
  if (id === "") {
    return err(domainError("VALIDATION_FAILED", "hard rule id must not be blank"));
  }

  const topicId = input.topicId.trim();
  if (topicId === "") {
    return err(domainError("VALIDATION_FAILED", "hard rule topic id must not be blank"));
  }

  // Consecutive wildcards match exactly what one matches, so collapsing them
  // keeps a pattern's specificity and its identity (set-level duplicate
  // detection) in agreement.
  const pattern = input.pattern.trim().replace(/\*{2,}/g, WILDCARD);
  if (pattern === "") {
    return err(domainError("VALIDATION_FAILED", "hard rule pattern must not be blank"));
  }

  if (literalLength(pattern) === 0) {
    return err(
      domainError("VALIDATION_FAILED", "hard rule pattern must pin at least one character"),
    );
  }

  return ok({ id, pattern, topicId });
};

// Whole-subject and case-insensitive: `SEC-*` claims `sec-014` but not
// `XSEC-014`. Identifier casing varies between tenders and an unanchored
// pattern would claim any document that merely mentions the identifier.
export const matchesHardRule = (rule: HardRule, subject: string): boolean => {
  const trimmedSubject = subject.trim();
  if (trimmedSubject === "") return false;

  return patternToRegExp(rule.pattern).test(trimmedSubject);
};

// How much of a subject a pattern pins, in characters. This is the precedence
// order between two rules that both match (ADR-0011).
export const hardRuleSpecificity = (rule: HardRule): number => literalLength(rule.pattern);

// The rules a lens carries, in declaration order — the order is load-bearing as
// the tie-break between two equally specific rules. Empty is legitimate: the
// first pass runs with no hard rules at all (ADR-0008).
export interface HardRuleSet {
  readonly rules: readonly HardRule[];
}

export interface MakeHardRuleSetInput {
  readonly rules: readonly HardRule[];
}

export const makeHardRuleSet = (input: MakeHardRuleSetInput): Result<HardRuleSet> => {
  const ids = new Set(input.rules.map((rule) => rule.id));
  if (ids.size !== input.rules.length) {
    return err(domainError("VALIDATION_FAILED", "hard rule ids must be unique within a set"));
  }

  // Two rules with the same pattern can never be told apart by precedence, so
  // one of them is unreachable — an authoring error, caught here rather than
  // silently resolved at evaluation.
  const patterns = new Set(input.rules.map((rule) => rule.pattern.toLowerCase()));
  if (patterns.size !== input.rules.length) {
    return err(domainError("VALIDATION_FAILED", "hard rule patterns must be unique within a set"));
  }

  return ok({ rules: [...input.rules] });
};
