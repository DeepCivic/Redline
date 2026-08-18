// @redline/redline-domain — public surface.
//
// Primitives plus the port interfaces the CSV pipeline (M1–M5) builds against.
// The other port re-exports this package once carried belonged to the retired
// evaluation-surface architecture and return only if a CSV genuinely needs them.
export * from "./result";
export * from "./errors/domain-error";

// Ports
export * from "./ports/procurement-extraction-reader";
