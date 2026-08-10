import {
  domainError,
  err,
  evaluateHardRules,
  isErr,
  ok,
  type AdjudicationCandidate,
  type ChunkRow,
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
//      document addresses, each with the chunks that placed it. Every addressed
//      topic becomes its own row (the (document, topic) grain), carrying the
//      chunk that placed *that* topic and the element that chunk came from, so a
//      downstream summary and deep-link are per-topic rather than per-document.
//
// A document that matched nothing does not vanish: a grid is rows, so an
// unmatched document is invisible unless it carries one. Two no-match reasons
// stay distinguishable — a document the model said addresses nothing
// ("addressed_nothing") and one the store held no chunks for ("no_extraction") —
// each surfacing as one row with a null requirementId and its reason set, which
// is what lets a specialist tell "they answered nothing we asked" from "we never
// read this file".
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
      // A claimed document still yields one row per matching rule — the rule leg
      // keeps its own grain, not one row per lens topic.
      if (outcome.kind === "claimed") {
        rows.push({
          documentId: outcome.documentId,
          requirementId: outcome.topicId,
          confidence: CERTAIN,
          sourceChunkId: null,
          sourceElementOrder: null,
          unclassified: null,
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
      rows.push(...adjudicated.data);
    }

    return ok(rows);
  }

  // Fetch a document's chunks verbatim by structure and let the model name the
  // topics it addresses. Returns one row per addressed topic, or a single
  // unclassified row for either no-match reason — never an empty array, so no
  // document ever vanishes from the grid.
  //   - "no_extraction": the store held no chunks for the document (an absent
  //     extraction is a legitimate outcome, not a failed run — ADR-0018);
  //   - "addressed_nothing": the model read the passages and named no topic.
  private async adjudicate(
    evaluationId: string,
    documentId: string,
    adjudicationCandidates: readonly AdjudicationCandidate[],
  ): Promise<Result<readonly RequirementClassification[]>> {
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

    // No chunks for this document — we never read this file. One unclassified
    // row carries that reason so a specialist sees it, distinct from a document
    // the model read and found nothing in.
    if (fetched.data.length === 0) {
      return ok([unclassifiedRow(documentId, "no_extraction")]);
    }

    const chunksById = new Map(fetched.data.map((chunk) => [chunk.chunkId, chunk]));
    const passages = fetched.data.map((chunk) => ({
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
    // lens asks about. One unclassified row keeps it visible, carrying the reason
    // that distinguishes it from a file we never read.
    if (verdict.data.topics.length === 0) {
      return ok([unclassifiedRow(documentId, "addressed_nothing")]);
    }

    const offeredTopicIds = new Set(adjudicationCandidates.map((candidate) => candidate.topicId));
    const rows: RequirementClassification[] = [];

    // One row per topic the document addresses (the (document, topic) grain),
    // each carrying the chunk the model cited as placing *that* topic and the
    // element that chunk came from — so a downstream summary and deep-link are
    // per-topic rather than repeating the document's first passage on every row.
    for (const addressed of verdict.data.topics) {
      // The model must name a topic it was offered — never invent one. The port
      // promises this; the classifier enforces it at the boundary.
      if (!offeredTopicIds.has(addressed.topicId)) {
        return err(
          domainError(
            "CLASSIFICATION_FAILED",
            `adjudicator returned topic '${addressed.topicId}', which was not offered for document '${documentId}'`,
          ),
        );
      }

      // Provenance is the chunk the model cited as placing the topic. The port
      // guarantees at least one; a verdict without evidence is a broken
      // implementation, not a row to emit.
      const [evidenceChunkId] = addressed.evidenceChunkIds;
      if (evidenceChunkId === undefined) {
        return err(
          domainError(
            "CLASSIFICATION_FAILED",
            `adjudicator returned topic '${addressed.topicId}' with no evidence for document '${documentId}'`,
          ),
        );
      }

      rows.push({
        documentId,
        requirementId: addressed.topicId,
        confidence: CERTAIN,
        sourceChunkId: evidenceChunkId,
        sourceElementOrder: elementOrderOf(chunksById.get(evidenceChunkId)),
        unclassified: null,
      });
    }

    return ok(rows);
  }
}

// The element a chunk came from, for a row's deep-link. `chunkIndex` is the
// stable ordinal the store carries (ADR-0014); a cited chunk that is not in the
// fetched set (a hallucination the adjudicator port already rejects) leaves it
// unresolved rather than pointing at element 0.
const elementOrderOf = (chunk: ChunkRow | undefined): number | null =>
  chunk ? chunk.chunkIndex : null;

// One row for a document that matched no requirement, carrying why. A null
// requirementId is the unclassified signal; the reason is what a specialist
// reads to tell the two no-match cases apart.
const unclassifiedRow = (
  documentId: string,
  reason: RequirementClassification["unclassified"],
): RequirementClassification => ({
  documentId,
  requirementId: null,
  confidence: CERTAIN,
  sourceChunkId: null,
  sourceElementOrder: null,
  unclassified: reason,
});
