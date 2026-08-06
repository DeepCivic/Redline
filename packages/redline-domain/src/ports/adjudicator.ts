import type { Result } from "../result";

// The lens's LLM adjudication seam (design doc §3, "LLM adjudication → clear
// match + one-sentence rationale"). Given a document's passages and the lens's
// candidate topics, the model returns **every topic the document addresses** and
// the chunks that placed each one.
//
// It is set-valued, not single-valued, because a tender response is: each
// response in the pilot corpus answers four requirements, so a one-topic verdict
// discards what is on the page. The evidence is not decoration either — it is
// what lets each (document, topic) row summarise and deep-link to its own
// passages instead of repeating the document's first chunk on every row.
//
// **One call per document, not one per topic.** The whole document's passages go
// up once and the model returns the set. That keeps cost at M calls rather than
// N×M, and it is why evidence has to be an explicit field: a per-topic call
// would have carried the topic implicitly, and this does not.
//
// This is a *distinct port*, not a second method on ILanguageModel (open
// question #2). `ILanguageModel.summarise` is procurement-shaped
// (`{ vendorName, productName, passages }`) and shape-coupled to the review
// grid's product summary; adjudication is a lens concern with a different input
// (candidate topics) and a different output. Keeping the seams apart honours the
// composable-operations design (§3, D4): each operation is an independent
// function with its own port, not an overloaded one.
//
// An adapter implements this over whatever model runtime the deployment uses;
// the application layer sees only a Result-returning port, so no AI SDK leaks
// past the boundary and the use-case stays unit-testable with a fake.

// One candidate topic the document might address — the name and definition the
// model reasons over. The model chooses among exactly these, never inventing one.
export interface AdjudicationCandidate {
  readonly topicId: string;
  readonly name: string;
  readonly definition: string;
}

// One passage the model reads, addressed by the chunk it came from. The chunk id
// travels with the text because the verdict has to name it back: a topic is
// returned with the chunks that placed it, and an id the request never offered
// is a hallucinated citation rather than evidence.
export interface AdjudicationPassage {
  readonly chunkId: string;
  readonly text: string;
}

export interface AdjudicationRequest {
  readonly documentId: string;
  // The document's passages — the material the model reads to decide, supplied
  // by the caller (the store's chunks for this document).
  readonly passages: readonly AdjudicationPassage[];
  // The lens's topics. Adjudication only runs when there is a genuine choice to
  // make, so a caller supplies ≥2 candidates.
  readonly candidates: readonly AdjudicationCandidate[];
}

// One topic the document addresses. `topicId` is a requirement's id it projects
// to (ADR-0010), so it becomes a RequirementClassification's `requirementId`
// directly and the two classification paths still interchange at the port (D2);
// the rationale and evidence ride alongside, not inside the shared shape.
//
// `evidenceChunkIds` is never empty and every id was offered in the request's
// passages — an implementation that cannot honour that returns an error instead.
// There is deliberately **no per-topic score**: `AGENTS.md` forbids quality
// scoring while the data is this poorly understood, so a topic is addressed or
// it is not.
export interface AdjudicatedTopic {
  readonly topicId: string;
  readonly evidenceChunkIds: readonly string[];
  readonly rationale: string;
}

// What the one call cost, so the spend is known rather than assumed. Null when
// the model runtime reported no usage — reporting zeroes there would be a
// fabricated figure, which is worse than an absent one.
export interface AdjudicationCost {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

// A document that addresses none of the lens's topics. This is a real verdict,
// not a failed call, but it produces **zero rows** — so left as a bare empty
// array a caller could skip it without noticing, and the document would vanish
// from the evaluation with no way to tell "this vendor answered nothing we
// asked" from "this file was never ingested". The exception is how the first of
// those two reasons reaches whoever is running the evaluation.
export interface AdjudicationException {
  readonly documentId: string;
  // The model's own account of why nothing matched — the part a specialist
  // reads. A caller that only needs "empty" can check `topics` instead.
  readonly detail: string;
}

// The verdict for one document, from one call.
//
// Invariant: `exception` is non-null exactly when `topics` is empty.
export interface Adjudication {
  readonly documentId: string;
  readonly topics: readonly AdjudicatedTopic[];
  readonly exception: AdjudicationException | null;
  readonly cost: AdjudicationCost | null;
}

export interface IAdjudicator {
  adjudicate(request: AdjudicationRequest): Promise<Result<Adjudication>>;
}
