import {
  domainError,
  err,
  evaluateHardRules,
  isErr,
  ok,
  type AdjudicationCandidate,
  type ClassificationLens,
  type ClassificationRequest,
  type HardRuleCandidate,
  type HardRuleSet,
  type IAdjudicator,
  type IChunkStore,
  type IClassificationLensReader,
  type IProcurementClassifier,
  type RequirementClassification,
  type Result,
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
//      similarity ranking — and the adjudicator names the lens topics the
//      document addresses, each with the chunks that placed it.
//
// The lens context (topics, rule set, per-document candidates) is resolved
// **per call** through `IClassificationLensReader`, not held as constructor
// state. `ClassificationRequest` carries no lens, so a classifier that bound one
// at construction could serve only one evaluation — fatal at the seam the served
// UI binds at, where the fork's `getContainer()` is a process-wide memoised
// singleton. Reading it per call makes this a legitimate process-lifetime
// singleton, and `classifyResponseGroup` keeps the port's exact signature.
//
// `findSimilar` is deliberately never called — the class must run without the
// deferred nearest-neighbour step. When vector search lands, a placing leg can
// be inserted between (1) and (2) without changing this port or its output.

export interface ColdStartClassifierDependencies {
  readonly chunkStore: IChunkStore;
  readonly adjudicator: IAdjudicator;
  // The route from an evaluation to the lens it classifies against.
  readonly lensReader: IClassificationLensReader;
}

// A hard-rule claim and an adjudicated match are both certainties, not ranked
// guesses (the same confidence the hard-rule and adjudication legs assign
// elsewhere). Cold start carries no similarity score to report.
const CERTAIN = 1;

// The lens indexed for one call: candidates keyed by document so the rule
// pre-pass is a lookup, and topics already in the adjudicator's shape.
interface IndexedLens {
  readonly ruleSet: HardRuleSet;
  readonly candidatesByDocument: Map<string, HardRuleCandidate>;
  readonly adjudicationCandidates: readonly AdjudicationCandidate[];
}

const indexLens = (lens: ClassificationLens): IndexedLens => ({
  ruleSet: lens.ruleSet,
  candidatesByDocument: new Map(
    lens.candidates.map((candidate) => [candidate.documentId, candidate]),
  ),
  // A topic's id is the requirement's id it projects to (ADR-0010), so the
  // chosen topic's id becomes the requirementId directly — no mapping table.
  adjudicationCandidates: lens.topics.map((topic) => ({
    topicId: topic.id,
    name: topic.name,
    definition: topic.definition,
  })),
});

export class ColdStartClassifier implements IProcurementClassifier {
  constructor(private readonly dependencies: ColdStartClassifierDependencies) {}

  async classifyResponseGroup(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>> {
    const read = await this.dependencies.lensReader.readLens({
      evaluationId: request.evaluationId,
      documentIds: request.documentIds,
    });
    if (isErr(read)) return err(read.error);

    const lens = indexLens(read.data);
    const rows: RequirementClassification[] = [];

    for (const documentId of request.documentIds) {
      const candidate = lens.candidatesByDocument.get(documentId) ?? { documentId, subjects: [] };
      const outcome = evaluateHardRules({ ruleSet: lens.ruleSet, candidate });

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
      const adjudicated = await this.adjudicate(
        request.evaluationId,
        documentId,
        lens.adjudicationCandidates,
      );
      if (isErr(adjudicated)) return adjudicated;
      if (adjudicated.data) rows.push(adjudicated.data);
    }

    return ok(rows);
  }

  // Fetch a document's chunks verbatim by structure and let the model name the
  // topics it addresses. Two documents produce no row and are skipped rather
  // than failed: one the store has no chunks for (an absent extraction is a
  // legitimate outcome, not a failed run — ADR-0018), and one the model says
  // addresses nothing in the lens. Returns null for both.
  //
  // The verdict is set-valued but only its first topic becomes a row here: the
  // (document, topic) grain is delivery-plan item 2's change to this class, and
  // carrying both exceptions to a surface a specialist reads belongs with it.
  private async adjudicate(
    evaluationId: string,
    documentId: string,
    adjudicationCandidates: readonly AdjudicationCandidate[],
  ): Promise<Result<RequirementClassification | null>> {
    // Adjudication is a choice: with fewer than two topics there is nothing to
    // adjudicate. Refuse before touching the store or the model.
    if (adjudicationCandidates.length < 2) {
      return err(
        domainError(
          "VALIDATION_FAILED",
          `cold-start classification needs at least two topics in contention; the lens has ${adjudicationCandidates.length}`,
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

    const passages = [firstChunk, ...restChunks].map((chunk) => ({
      chunkId: chunk.chunkId,
      text: chunk.text,
    }));
    const verdict = await this.dependencies.adjudicator.adjudicate({
      documentId,
      passages,
      candidates: adjudicationCandidates,
    });
    if (isErr(verdict)) return err(verdict.error);

    // An empty set is a verdict, not a fault: the document addresses nothing the
    // lens asks about, so there is no row to emit.
    const [addressed] = verdict.data.topics;
    if (addressed === undefined) return ok(null);

    // The model must name a topic it was offered — never invent one. The port
    // promises this; the classifier enforces it at the boundary.
    const chosen = adjudicationCandidates.find(
      (candidate) => candidate.topicId === addressed.topicId,
    );
    if (!chosen) {
      return err(
        domainError(
          "CLASSIFICATION_FAILED",
          `adjudicator returned topic '${addressed.topicId}', which was not offered for document '${documentId}'`,
        ),
      );
    }

    // Provenance is the chunk the model cited as placing the topic, not the
    // document's first chunk. The port guarantees at least one; a verdict
    // without evidence is a broken implementation, not a row to emit.
    const [evidenceChunkId] = addressed.evidenceChunkIds;
    if (evidenceChunkId === undefined) {
      return err(
        domainError(
          "CLASSIFICATION_FAILED",
          `adjudicator returned topic '${addressed.topicId}' with no evidence for document '${documentId}'`,
        ),
      );
    }

    return ok({
      documentId,
      requirementId: chosen.topicId,
      confidence: CERTAIN,
      sourceChunkId: evidenceChunkId,
    });
  }
}
