// The identifier-token pre-pass `IClassificationLensReader` composes.
//
// `ClassificationLens.candidates` are derived per call, never stored: they
// depend on the request's documentIds, so storing them would mean invalidating
// them every time a document joins an evaluation. Every existing caller passed
// `HardRuleCandidate.subjects` in by hand; this is the first thing that derives
// them from a real extraction.
//
// Hard rules match IDENTIFIERS, never prose — a rule that read body text would
// be a classifier (hard-rule-evaluation.ts). So the whole judgement here is
// which tokens are identifiers, and the rule is deliberately narrow: a token
// must carry at least one letter AND at least one digit. That admits SEC-014,
// REQ_12 and ISO9001 while rejecting every prose word and every bare number.

import {
  err,
  isErr,
  ok,
  type HardRuleCandidate,
  type IProcurementExtractionReader,
  type Result,
} from "@redline/redline-domain";

export type DeriveHardRuleCandidates = (
  evaluationId: string,
  documentIds: readonly string[],
) => Promise<Result<readonly HardRuleCandidate[]>>;

// Identifiers keep internal hyphens and underscores (SEC-014, REQ_12); every
// other character is a separator, so surrounding punctuation falls away without
// a trim pass.
const SEPARATORS = /[^\p{L}\p{N}_-]+/u;

const hasLetter = /\p{L}/u;
const hasDigit = /\p{N}/u;

// Leading/trailing hyphens are separators that survived the split ("-SEC-014-"),
// not part of the identifier.
const trimDashes = (token: string): string => token.replace(/^[-_]+/, "").replace(/[-_]+$/, "");

const isIdentifier = (token: string): boolean =>
  hasLetter.test(token) && hasDigit.test(token);

const identifiersIn = (text: string): string[] =>
  text
    .split(SEPARATORS)
    .map(trimDashes)
    .filter(isIdentifier);

export const makeExtractionHardRuleCandidateDeriver = (
  extractionReader: IProcurementExtractionReader,
): DeriveHardRuleCandidates => {
  const deriveOne = async (
    evaluationId: string,
    documentId: string,
  ): Promise<Result<HardRuleCandidate>> => {
    const read = await extractionReader.readElements(evaluationId, documentId);
    if (isErr(read)) return err(read.error);

    // Deduped, first-seen order preserved: a Set keyed on the token is enough
    // because a repeat carries no extra matching power.
    const subjects = new Set<string>();
    for (const element of read.data) {
      for (const identifier of identifiersIn(element.text)) subjects.add(identifier);
    }

    return ok({ documentId, subjects: [...subjects] });
  };

  return async (evaluationId, documentIds) => {
    const candidates: HardRuleCandidate[] = [];
    for (const documentId of documentIds) {
      const derived = await deriveOne(evaluationId, documentId);
      if (isErr(derived)) return err(derived.error);
      candidates.push(derived.data);
    }
    return ok(candidates);
  };
};
