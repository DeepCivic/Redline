// @redline/redline-domain — public surface.
//
// Primitives plus the port interfaces of the corpus-ingest-and-report
// substrate. There are no entities: redline stages a corpus, drives the womblex
// run over it, and serves the rows that run lands. Nothing here models a
// procurement judgement.
export * from "./result";
export * from "./errors/domain-error";

// The one surviving read port: the run-scoped, schema-carrying shard seam over
// the womblex-ingest sidecar. It serves womblex's own columns verbatim. The
// chunk-store, money-span-store, graph-store, staged-corpus-reader/writer and
// womblex-run-trigger ports were removed with their implementations — see
// docs/Redline-Status.md for what replaces them.
export * from "./ports/womblex-asset-reader";
