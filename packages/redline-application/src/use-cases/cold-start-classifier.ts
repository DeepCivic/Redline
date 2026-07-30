import {
  domainError,
  err,
  evaluateHardRules,
  isErr,
  ok,
  type AdjudicationCandidate,
  type ClassificationRequest,
  type HardRuleCandidate,
  type HardRuleSet,
  type IAdjudicator,
  type IChunkStore,
  type IProcurementClassifier,
  type RequirementClassification,
  type Result,
  type Topic,
} from "@redline/redline-domain";

// ColdStartClassifier — the untrained first-pass IProcurementClassifier
// (ADR-0008's cold start, in the ADR-0018-addendum shape). It is what makes
// classification demonstrable with no Numbatch running, no curated samples and
// no trained adapter: a deployment wires it behind the same IProcurementClassifier
// port the trained overlay satisfies, so a consumer (BuildEvaluationTable, the
// review grid, the document map) cannot tell which path ran (D2).
//
// ADR-0008's pipeline is "hard rules → retrieval (nearest-neighbour) → LLM
// adjudication". Only the nearest-neighbour placing step needs vector similarity,
// which ADR-0018's addendum defers (no `pgvector`/ANN index, `findSimilar`
// unimplemented this release). So this classifier runs the two legs that do not
// need it:
//
//   1. Hard rules — the deterministic pre-pass. A document a rule claims is
//      resolved here (confidence 1, no source chunk) and never reaches the store
//      or the model. `evaluateHardRules` is the pure domain's; this composes it.
//   2. LLM adjudication over *exact/structural* fetch. For every unclaimed
//      document, its passages are read verbatim from the store by structure
//      (`fetchByStructure({ documentId })`) — the transfer mechanic, not a
//      similarity ranking — and the adjudicator chooses among the lens topics.
//
// The lens context (topics, rule set, per-document candidates) is fixed at
// construction: it belongs to the evaluation's lens, not to a single
// classifyResponseGroup call, the same way NumbatchClassifier holds its profile
// binding. `classifyResponseGroup` therefore keeps the port's exact signature.
//
// `findSimilar` is deliberately never called — the class must run without the
// deferred nearest-neighbour step. When vector search lands, a placing leg can
// be inserted between (1) and (2) without changing this port or its output.

export interface ColdStartClassifierDependencies {
  readonly chunkStore: IChunkStore;
  readonly adjudicator: IAdjudicator;
  // The lens's topics — the candidates the model chooses among, each carrying
  // the definition it reasons over. A topic's id is the requirement's id it
  // projects to (ADR-0010), so the chosen topic's id becomes the requirementId
  // directly — no mapping table.
  readonly topics: readonly Topic[];
  // The lens's hard rules, in declaration order. May be empty — then every
  // document is unclaimed and falls through to adjudication (ADR-0008).
  readonly ruleSet: HardRuleSet;
  // Per-document identifier tokens for the hard-rule pre-pass. A document with
  // no candidate here offers no subjects: unclaimed, and adjudicated.
  readonly candidates: readonly HardRuleCandidate[];
}

// A hard-rule claim and an adjudicated match are both certainties, not ranked
// guesses (the same confidence the hard-rule and adjudication legs assign
// elsewhere). Cold start carries no similarity score to report.
const CERTAIN = 1;

export class ColdStartClassifier implements IProcurementClassifier {
  private readonly candidatesById: Map<string, HardRuleCandidate>;
  private readonly adjudicationCandidates: readonly AdjudicationCandidate[];

  constructor(private readonly dependencies: ColdStartClassifierDependencies) {
    this.candidatesById = new Map(
      dependencies.candidates.map((candidate) => [candidate.documentId, candidate]),
    );
    this.adjudicationCandidates = dependencies.topics.map((topic) => ({
      topicId: topic.id,
      name: topic.name,
      definition: topic.definition,
    }));
  }

  async classifyResponseGroup(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>> {
    const rows: RequirementClassification[] = [];

    for (const documentId of request.documentIds) {
      const candidate = this.candidatesById.get(documentId) ?? { documentId, subjects: [] };
      const outcome = evaluateHardRules({ ruleSet: this.dependencies.ruleSet, candidate });

      // 1. A rule claim is deterministic and final: no store read, no model call.
      if (outcome.kind === "claimed") {
        rows.push({
          documentId: outcome.documentId,
          requirementId: outcome.topicId,
          confidence: CERTAIN,
          sourceChunkId: null,
        });
        continue;
      }

      // 2. Unclaimed → adjudicate over exact-fetch passages (no similarity).
      const adjudicated = await this.adjudicate(request.evaluationId, documentId);
      if (isErr(adjudicated)) return adjudicated;
      if (adjudicated.data) rows.push(adjudicated.data);
    }

    return ok(rows);
  }

  // Fetch a document's chunks verbatim by structure and let the model pick a
  // topic. A document the store has no chunks for is skipped — an absent
  // extraction is a legitimate outcome, not a failed run (ADR-0018), so the rest
  // of the group still classifies. Returns null for a skipped document.
  private async adjudicate(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<RequirementClassification | null>> {
    // Adjudication is a choice: with fewer than two topics there is nothing to
    // adjudicate. Refuse before touching the store or the model.
    if (this.adjudicationCandidates.length < 2) {
      return err(
        domainError(
          "VALIDATION_FAILED",
          `cold-start classification needs at least two topics in contention; the lens has ${this.adjudicationCandidates.length}`,
        ),
      );
    }

    const fetched = await this.dependencies.chunkStore.fetchByStructure(evaluationId, {
      documentId,
    });
    if (isErr(fetched)) return err(fetched.error);

    // No chunks for this document — nothing to read, so nothing to classify.
    const [firstChunk, ...restChunks] = fetched.data;
    if (firstChunk === undefined) return ok(null);

    const passages = [firstChunk, ...restChunks].map((chunk) => chunk.text);
    const verdict = await this.dependencies.adjudicator.adjudicate({
      documentId,
      passages,
      candidates: this.adjudicationCandidates,
    });
    if (isErr(verdict)) return err(verdict.error);

    // The model must choose a topic it was offered — never invent one. The port
    // promises this; the classifier enforces it at the boundary.
    const chosen = this.adjudicationCandidates.find(
      (c) => c.topicId === verdict.data.chosenTopicId,
    );
    if (!chosen) {
      return err(
        domainError(
          "CLASSIFICATION_FAILED",
          `adjudicator chose topic '${verdict.data.chosenTopicId}', which was not offered for document '${documentId}'`,
        ),
      );
    }

    return ok({
      documentId,
      // The chosen topic's id is the requirement's id it projects to (ADR-0010).
      requirementId: chosen.topicId,
      confidence: CERTAIN,
      // Provenance: the strongest signal is the first fetched chunk. Without a
      // similarity ranking (deferred), the store's stable order stands in for
      // "which chunk carried it" — the first chunk of the document.
      sourceChunkId: firstChunk.chunkId,
    });
  }
}
