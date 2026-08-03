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
// Adjudication — the lens's LLM seam; picks among contending topics
// for what retrieval left unclear and returns a one-sentence rationale.
export * from "./ports/adjudicator";
// Retrieval store — the ADR-0018 store-side query surface (item 1a/1b). Exact
// fetch by provenance ships now; vector similarity (findSimilar) is declared
// but deferred (ADR-0018 addendum). No vector ever crosses this seam.
export * from "./ports/chunk-store";
// The evaluation-scoped lens context, read per call so one classifier instance
// serves every evaluation in a process (the fork's getContainer() is a
// process-wide singleton).
export * from "./ports/classification-lens-reader";
export * from "./ports/embedding-reader";
export * from "./ports/evaluation-repository";
export * from "./ports/financial-extractor";
export * from "./ports/language-model";
// Money spans — the store-side query surface over womblex's `money` sidecar
// (ADR-0017/0018). Addressable, provenance-tagged pricing facts; requirement
// alignment is the report-assembler LLM's job over the graph, not this seam's.
export * from "./ports/money-span-store";
export * from "./ports/procurement-classifier";
export * from "./ports/procurement-extraction-reader";

// Retrieval — embeds a topic definition into a query vector, in the
// same space as the chunk vectors, so the lens's first pass can match without a
// trained model (ADR-0014).
export * from "./ports/text-embedder";
