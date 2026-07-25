import { hardRuleSpecificity, matchesHardRule, type HardRule, type HardRuleSet } from "./hard-rule";

// What a document offers a rule to match against: its identifier tokens, pulled
// out by the caller (the Thread 21 pre-pass). Hard rules match identifiers, not
// prose — a rule that read the body text would be a classifier.
export interface HardRuleCandidate {
  readonly documentId: string;
  readonly subjects: readonly string[];
}

export interface HardRuleClaim {
  readonly kind: "claimed";
  readonly documentId: string;
  readonly topicId: string;
  readonly ruleId: string;
  readonly matchedSubject: string;
}

// No rule matched. Not a `DomainError`: a document no rule claims is the normal
// case and falls through to retrieval (design doc §3, "a per-document gap is
// skipped; only genuine misuse raises").
export interface HardRuleGap {
  readonly kind: "unclaimed";
  readonly documentId: string;
}

export type HardRuleOutcome = HardRuleClaim | HardRuleGap;

export interface EvaluateHardRulesInput {
  readonly ruleSet: HardRuleSet;
  readonly candidate: HardRuleCandidate;
}

interface PossibleMatch {
  readonly rule: HardRule;
  readonly subject: string | undefined;
}

interface Match extends PossibleMatch {
  readonly subject: string;
}

const isMatch = (possible: PossibleMatch): possible is Match => possible.subject !== undefined;

// Pure and total: every candidate yields an outcome, and nothing here reads a
// clock, a store or a model. Precedence between two matching rules is
// specificity first, declaration order second (ADR-0011).
export const evaluateHardRules = (input: EvaluateHardRulesInput): HardRuleOutcome => {
  const subjects = input.candidate.subjects.map((subject) => subject.trim());

  const matches = input.ruleSet.rules
    .map((rule) => ({ rule, subject: subjects.find((subject) => matchesHardRule(rule, subject)) }))
    .filter(isMatch);

  if (matches.length === 0) {
    return { kind: "unclaimed", documentId: input.candidate.documentId };
  }

  const winner = matches.reduce((best, contender) =>
    hardRuleSpecificity(contender.rule) > hardRuleSpecificity(best.rule) ? contender : best,
  );

  return {
    kind: "claimed",
    documentId: input.candidate.documentId,
    topicId: winner.rule.topicId,
    ruleId: winner.rule.id,
    matchedSubject: winner.subject,
  };
};
