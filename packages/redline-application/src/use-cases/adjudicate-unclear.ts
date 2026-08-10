import {
  isErr,
  ok,
  err,
  domainError,
  type AdjudicatedTopic,
  type AdjudicationCandidate,
  type AdjudicationPassage,
  type AdjudicationRequest,
  type ClassificationRequest,
  type IAdjudicator,
  type RequirementClassification,
  type Result,
} from "@redline/redline-domain";

// AdjudicateUnclear — the third leg of the lens's first-pass classification
// (design doc §3, "LLM adjudication → clear match + one-sentence rationale").
// It runs *only* on what retrieval left genuinely unclear: for each
// such document it asks the IAdjudicator port which of the contending topics the
// document addresses, and to say, in one sentence, why. What retrieval settled
// cleanly, and what a hard rule already claimed, never reach the model.
//
// A document addressing more than one topic yields one row per topic, each
// sourced from the chunk the model cited as placing it. A document addressing
// none yields no rows.
//
// This is one independent leg of §3, composed by the caller, not chained to the
// hard-rule pre-pass or retrieval (no orchestrator, D4). The caller decides what
// is "unclear" — Thread 24's Clear/Ambiguous derivation is what will feed this
// in the wired container; here the unclear set is an input.
//
// Interchangeability at the port boundary (D2): each row is a
// RequirementClassification with one extra field, `rationale`. Strip that field
// and a downstream (the review grid, the document map) sees exactly the shape
// the hard-rule, retrieval and Numbatch paths emit. The rationale rides
// alongside the shared shape, never inside it.

// A RequirementClassification enriched with the model's one-sentence rationale.
// The base shape is untouched, so it interchanges with the other paths.
export interface AdjudicatedClassification extends RequirementClassification {
  readonly rationale: string;
}

// One document retrieval could not cleanly separate, together with the passages
// the model should read and the topics in contention. Each passage carries the
// chunk it came from, so the verdict can cite the chunk that placed a topic and
// each emitted row names its own provenance.
export interface UnclearDocument {
  readonly documentId: string;
  readonly passages: readonly AdjudicationPassage[];
  readonly candidates: readonly AdjudicationCandidate[];
}

export interface AdjudicateUnclearDependencies {
  readonly adjudicator: IAdjudicator;
}

export interface AdjudicateUnclearInput {
  // The response group being classified — the evaluation context. `documentIds`
  // is the full set; `unclear` is the subset that actually reaches the model.
  readonly request: ClassificationRequest;
  // The documents retrieval left unclear. May be empty — then the model is
  // never called and the result is empty.
  readonly unclear: readonly UnclearDocument[];
}

export class AdjudicateUnclear {
  constructor(private readonly dependencies: AdjudicateUnclearDependencies) {}

  async execute(
    input: AdjudicateUnclearInput,
  ): Promise<Result<readonly AdjudicatedClassification[]>> {
    const rows: AdjudicatedClassification[] = [];

    for (const document of input.unclear) {
      // Adjudication is a choice: with fewer than two candidates there is
      // nothing to adjudicate. Refuse before spending a model call.
      if (document.candidates.length < 2) {
        return err(
          domainError(
            "VALIDATION_FAILED",
            `document '${document.documentId}' offers ${document.candidates.length} candidate(s); adjudication needs at least two`,
          ),
        );
      }

      const adjudicationRequest: AdjudicationRequest = {
        documentId: document.documentId,
        passages: document.passages,
        candidates: document.candidates,
      };

      const verdict = await this.dependencies.adjudicator.adjudicate(adjudicationRequest);
      if (isErr(verdict)) return err(verdict.error);

      const emitted = emitRows(document, verdict.data.topics);
      if (isErr(emitted)) return err(emitted.error);
      rows.push(...emitted.data);
    }

    return ok(rows);
  }
}

// One row per topic the document addresses. A topic's id is the requirement's id
// it projects to (ADR-0010), so it is written straight into `requirementId` — no
// mapping table, the same move the hard-rule and retrieval paths make.
const emitRows = (
  document: UnclearDocument,
  topics: readonly AdjudicatedTopic[],
): Result<readonly AdjudicatedClassification[]> => {
  const offeredTopicIds = new Set(document.candidates.map((candidate) => candidate.topicId));
  const rows: AdjudicatedClassification[] = [];

  for (const topic of topics) {
    // The model must name a topic it was offered — never invent one. The port
    // promises this; the use-case enforces it at the boundary.
    if (!offeredTopicIds.has(topic.topicId)) {
      return err(
        domainError(
          "VALIDATION_FAILED",
          `adjudicator returned topic '${topic.topicId}', which was not offered for document '${document.documentId}'`,
        ),
      );
    }

    const [evidenceChunkId] = topic.evidenceChunkIds;
    if (evidenceChunkId === undefined) {
      return err(
        domainError(
          "VALIDATION_FAILED",
          `adjudicator returned topic '${topic.topicId}' with no evidence for document '${document.documentId}'`,
        ),
      );
    }

    rows.push({
      documentId: document.documentId,
      requirementId: topic.topicId,
      // Adjudication is a decision, not a ranked score — a settled unclear case
      // is treated as certain (like a hard-rule claim, confidence 1).
      confidence: 1,
      sourceChunkId: evidenceChunkId,
      sourceElementOrder: null,
      unclassified: null,
      rationale: topic.rationale,
    });
  }

  return ok(rows);
};
