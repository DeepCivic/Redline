// @redline/redline-domain — public surface.
//
// Primitives plus the core entities and port interfaces.
export * from "./result";
export * from "./errors/domain-error";

// Entities
export * from "./entities/evaluation";
export * from "./entities/evaluation-structure";
export * from "./entities/requirement";
export * from "./entities/procurement-response";

// Comprehension lens — durable, evaluation-independent.
export * from "./entities/topic";
export * from "./entities/lens";
export * from "./entities/lens-projection";

// Hard rules — deterministic pattern -> topic, resolved before any model.
export * from "./entities/hard-rule";
export * from "./entities/hard-rule-evaluation";

// Comprehension — a named, statused ambiguity signal register
// (womblex's heuristics_disambiguation shape) and the pure Clear/Ambiguous
// derivation it drives. No confidence value escapes to the view model.
export * from "./entities/ambiguity-signal";
export * from "./entities/ambiguity-derivation";

// Ports
// Adjudication — the lens's LLM seam. One call per document returns every topic
// the document addresses, each with the chunks that placed it, plus the call's
// token cost and, for a document that addresses nothing, an exception.
export * from "./ports/adjudicator";
// Retrieval store — the ADR-0018 store-side query surface. Exact
// fetch by provenance ships now; vector similarity (findSimilar) is declared
// but deferred (ADR-0018 addendum). No vector ever crosses this seam.
export * from "./ports/chunk-store";
// What an evaluation can be created over: the corpora the sidecar has already
// staged, and the documents behind each. Read before an evaluation exists, so
// the operator picks a corpus id rather than retyping the one the store keys on.
export * from "./ports/staged-corpus-reader";
// The write half of the object-store seam — redline's first write-side
// object-store port. Puts a specialist's chosen bytes under
// `proc/{evaluationId}/inputs/`, the prefix the womblex runner reads its input
// from, so a browser upload reaches a run without a terminal `mc cp`.
export * from "./ports/staged-corpus-writer";
// The evaluation-scoped lens context, read per call so one classifier instance
// serves every evaluation in a process (the fork's getContainer() is a
// process-wide singleton).
export * from "./ports/classification-lens-reader";
// The write half of that seam — the minimum that lets a corpus driver seed the
// lens it is about to classify against. Not the authoring surface (deferred).
export * from "./ports/classification-lens-writer";
export * from "./ports/evaluation-repository";
export * from "./ports/financial-extractor";
export * from "./ports/language-model";
// Money spans — the store-side query surface over womblex's `money` sidecar
// (ADR-0017/0018). Addressable, provenance-tagged financial expressions; requirement
// alignment happens above this seam, and has more than one owner — the grid's
// extractor and the report assembler each read the same rows their own way.
export * from "./ports/money-span-store";
// Enrichment graph — the store-side view of womblex's `enrich` output (entities +
// directed edges), materialised into the redline_ store (ADR-0017/0018). The
// report assembler's navigation mechanic: entity → mentioned_in edge → chunk →
// verbatim text. No graph loaded is an empty read, never an error.
export * from "./ports/graph-store";
export * from "./ports/procurement-classifier";
export * from "./ports/procurement-extraction-reader";
// The run-trigger seam — redline's second coupling to the womblex engine. A
// trigger into the engine's job queue and a read of run state, so a browser
// starts and watches a run without a terminal driving enqueue / worker /
// run-stage. redline drives and observes; it does not reimplement the engine's
// batching, retry or scale-out.
export * from "./ports/womblex-run-trigger";
