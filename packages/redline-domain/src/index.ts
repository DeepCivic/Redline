// @redline/redline-domain — public surface.
//
// Primitives plus the port interfaces of the corpus-ingest-and-report
// substrate. There are no entities: redline stages a corpus, drives the womblex
// run over it, and serves the rows that run lands. Nothing here models a
// procurement judgement.
export * from "./result";
export * from "./errors/domain-error";

// Ports
// Retrieval store — the store-side query surface. Exact fetch by provenance
// ships now; vector similarity (findSimilar) is declared but deferred. No
// vector ever crosses this seam.
export * from "./ports/chunk-store";
// The corpora the sidecar has already staged, and the documents behind each.
// Read so an operator picks a corpus id rather than retyping the one the store
// keys on.
export * from "./ports/staged-corpus-reader";
// The write half of the object-store seam. Puts a specialist's chosen bytes
// under the prefix the womblex runner reads its input from, so a browser upload
// reaches a run without a terminal `mc cp`.
export * from "./ports/staged-corpus-writer";
// Money spans — the store-side query surface over womblex's `money` sidecar.
// Addressable, provenance-tagged financial expressions; interpretation happens
// above this seam and belongs to whichever consumer is reading.
export * from "./ports/money-span-store";
// Enrichment graph — the store-side view of womblex's `enrich` output (entities +
// directed edges), materialised into the redline_ store. The report assembler's
// navigation mechanic: entity → mentioned_in edge → chunk → verbatim text. No
// graph loaded is an empty read, never an error.
export * from "./ports/graph-store";
export * from "./ports/procurement-extraction-reader";
// The run-trigger seam — redline's second coupling to the womblex engine. A
// trigger into the engine's job queue and a read of run state, so a browser
// starts and watches a run without a terminal driving enqueue / worker /
// run-stage. redline drives and observes; it does not reimplement the engine's
// batching, retry or scale-out.
export * from "./ports/womblex-run-trigger";
// The allow-listed run-config override the Create Corpus form authors — the
// defined slice of the womblex config (chunk mode + money vocabulary) that
// plausibly differs as corpus nature changes. Blank inherits the file default;
// the smart constructor keeps a malformed override off the wire.
export * from "./ports/run-config-override";
