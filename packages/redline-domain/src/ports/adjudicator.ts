import type { Result } from "../result";

// The lens's LLM adjudication seam (design doc §3, "LLM adjudication → clear
// match + one-sentence rationale"). It settles what retrieval left
// genuinely unclear: given a document's passages and the candidate topics it
// could belong to, the model picks one topic and states, in one sentence, why.
//
// This is a *distinct port*, not a second method on ILanguageModel (open
// question #2). `ILanguageModel.summarise` is procurement-shaped
// (`{ vendorName, productName, passages }`) and shape-coupled to the review
// grid's product summary; adjudication is a lens concern with a different input
// (candidate topics) and a different output (a chosen topic + rationale).
// Keeping the seams apart honours the composable-operations design (§3, D4):
// each operation is an independent function with its own port, not an
// overloaded one.
//
// An adapter implements this over whatever model runtime the deployment uses;
// the application layer sees only a Result-returning port, so no AI SDK leaks
// past the boundary and the use-case stays unit-testable with a fake.

// One candidate topic the document might belong to — the name and definition
// the model reasons over. These are the topics retrieval could not cleanly
// separate; the model chooses among exactly these, never inventing one.
export interface AdjudicationCandidate {
  readonly topicId: string;
  readonly name: string;
  readonly definition: string;
}

export interface AdjudicationRequest {
  readonly documentId: string;
  // The document's passages — the material the model reads to decide. The
  // caller supplies the relevant chunks (e.g. those retrieval ranked highest).
  readonly passages: readonly string[];
  // The topics in contention. Adjudication only runs when there is a genuine
  // choice, so a caller supplies ≥2 candidates; the model must pick from them.
  readonly candidates: readonly AdjudicationCandidate[];
}

// The model's verdict: the topic it chose (one of the request's candidates) and
// the one-sentence rationale the design promises. `chosenTopicId` becomes a
// RequirementClassification's `requirementId` upstream (ADR-0010), so the two
// classification paths still interchange at the port (D2); the rationale rides
// alongside, not inside the shared shape.
export interface Adjudication {
  readonly documentId: string;
  readonly chosenTopicId: string;
  readonly rationale: string;
}

export interface IAdjudicator {
  adjudicate(request: AdjudicationRequest): Promise<Result<Adjudication>>;
}
