import {
  evaluateHardRules,
  isErr,
  ok,
  type ClassificationRequest,
  type HardRuleCandidate,
  type HardRuleSet,
  type IProcurementClassifier,
  type RequirementClassification,
  type Result,
} from "@redline/redline-domain";

// ClassifyWithHardRules — the lens's first classification stage (design doc §3,
// "hard rules → assigned"). It runs the deterministic pre-pass in front of the
// model: a document a rule claims is resolved here and never reaches the
// classifier; everything else falls through to Numbatch unchanged.
//
// The precedence and match logic are the pure domain's (Thread 18,
// `evaluateHardRules`) — this use-case composes that function, it does not
// re-implement it. Its only job is the routing: split claimed from unclaimed,
// synthesise classifications for the claimed, forward the rest, merge.
//
// Interchangeability at the port boundary (D2): both paths emit the same
// `RequirementClassification`, so a downstream (the review grid, the document
// map) cannot tell a rule-claimed row from a model-classified one by its shape.
export interface ClassifyWithHardRulesDependencies {
  readonly classifier: IProcurementClassifier;
}

export interface ClassifyWithHardRulesInput {
  // The response group being classified. `documentIds` is the full set; the
  // unclaimed subset is what actually reaches the classifier.
  readonly request: ClassificationRequest;
  // The lens's rules, in declaration order (Thread 18). May be empty — then
  // every document is unclaimed and the group forwards whole (ADR-0008).
  readonly ruleSet: HardRuleSet;
  // Per-document identifier tokens the caller extracted. A document with no
  // candidate here is treated as offering no subjects: unclaimed, and forwarded.
  readonly candidates: readonly HardRuleCandidate[];
}

// A hard-rule match is a certainty, not a scored guess: confidence is 1, and no
// chunk carried the signal (the match was on an identifier the caller supplied,
// not on body text), so `sourceChunkId` is null. Per ADR-0010 a topic's id is
// the id of the requirement it projects to, so the claimed `topicId` is the
// `requirementId` directly — no mapping table.
const RULE_MATCH_CONFIDENCE = 1;

export class ClassifyWithHardRules {
  constructor(private readonly dependencies: ClassifyWithHardRulesDependencies) {}

  async execute(
    input: ClassifyWithHardRulesInput,
  ): Promise<Result<readonly RequirementClassification[]>> {
    const candidatesById = new Map(
      input.candidates.map((candidate) => [candidate.documentId, candidate]),
    );

    const claimed: RequirementClassification[] = [];
    const unclaimedDocumentIds: string[] = [];

    for (const documentId of input.request.documentIds) {
      const candidate = candidatesById.get(documentId) ?? { documentId, subjects: [] };
      const outcome = evaluateHardRules({ ruleSet: input.ruleSet, candidate });

      if (outcome.kind === "claimed") {
        claimed.push({
          documentId: outcome.documentId,
          requirementId: outcome.topicId,
          confidence: RULE_MATCH_CONFIDENCE,
          sourceChunkId: null,
        });
      } else {
        unclaimedDocumentIds.push(outcome.documentId);
      }
    }

    // The exit test's core assertion: with nothing unclaimed the classifier is
    // never engaged. Skipping the call — not calling it with an empty list — is
    // what makes "claimed documents never reach the classifier" literally true.
    if (unclaimedDocumentIds.length === 0) {
      return ok(claimed);
    }

    const classified = await this.dependencies.classifier.classifyResponseGroup({
      evaluationId: input.request.evaluationId,
      responseGroupId: input.request.responseGroupId,
      documentIds: unclaimedDocumentIds,
    });
    if (isErr(classified)) return classified;

    return ok([...claimed, ...classified.data]);
  }
}
