import { implementedSignals, type RankedCandidate } from "./ambiguity-signal";

// Clear/Ambiguous derivation (design doc §3, "ambiguous → user resolves";
// non-goal §8, "No confidence scores in the UI. Replaced by Clear/Ambiguous
// buckets"). This is the pure read model that turns a document's ranked topic
// candidates into a single bucket by running the implemented ambiguity signals
// (`ambiguity-signal.ts`) over them.
//
// The load-bearing property of this thread: **no confidence value escapes**.
// The scores enter as input and are consumed by the signals; the output carries
// only the bucket and the ids of the signals that fired. A view model built on
// `Comprehension` cannot render a number, because there is no number to render.
//
// This is a pure, total function — no clock, store or model — and one leg of
// §3's composable design, called by whoever assembled the candidates (no
// orchestrator, D4). What it marks Ambiguous is what feeds the bounded collision
// surface (Threads 26–27) and, before that, the LLM adjudicator,
// whose "unclear" set is precisely the Ambiguous bucket here.

export interface ComprehensionInput {
  readonly documentId: string;
  // The document's ranked topic candidates. May be empty — a document nothing
  // scored is Ambiguous (there is nothing to be clear about).
  readonly candidates: readonly RankedCandidate[];
}

export type ComprehensionBucket = "clear" | "ambiguous";

// The derived read model. Exactly three fields — a document id, the bucket, and
// the ids of the signals that fired (empty when Clear). No score, no threshold,
// no candidate: everything a downstream may see, and nothing it may not.
export interface Comprehension {
  readonly documentId: string;
  readonly bucket: ComprehensionBucket;
  // The signals that considered this document ambiguous, in register order — so
  // the reason is legible ("close contenders", "no clear leader") without a
  // number. Empty iff the bucket is Clear.
  readonly firedSignals: readonly string[];
}

// A document is Ambiguous iff at least one implemented signal fires; otherwise
// Clear. Not-implemented signals pass through inert (the composable fallback
// idiom, §3), so wiring a new signal is an entry-status flip in the register,
// never a change here.
export const deriveComprehension = (input: ComprehensionInput): Comprehension => {
  const firedSignals = implementedSignals()
    .filter((signal) => signal.fires(input.candidates))
    .map((signal) => signal.id);

  return {
    documentId: input.documentId,
    bucket: firedSignals.length === 0 ? "clear" : "ambiguous",
    firedSignals,
  };
};
