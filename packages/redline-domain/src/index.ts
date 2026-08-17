// @redline/redline-domain — public surface.
//
// Primitives plus the port interfaces of the corpus-ingest-and-report
// substrate. There are no entities: redline stages a corpus, drives the womblex
// run over it, and serves the rows that run lands. Nothing here models a
// procurement judgement.
export * from "./result";
export * from "./errors/domain-error";

// The report data model (build plan §2) — columns, evidence, field values,
// rows, runs.
export * from "./report/types";

// The one port that survived 0a's removal, renamed evaluationId -> corpusId.
export * from "./ports/procurement-extraction-reader";

// The seven corpus-read/lifecycle ports 0a removed, redesigned fresh against
// the 0c corpus sample (build step 1).
export * from "./ports/chunk-store";
export * from "./ports/money-span-store";
export * from "./ports/graph-store";
export * from "./ports/staged-corpus-reader";
export * from "./ports/staged-corpus-writer";
export * from "./ports/womblex-run-trigger";
export * from "./ports/run-config-override";

// The base LLM extraction call seam (build plan §4).
export * from "./ports/extraction-model";
