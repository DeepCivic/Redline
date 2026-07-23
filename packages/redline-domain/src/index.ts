// @redline/redline-domain — public surface.
//
// Primitives (Thread 1) plus the core entities and port interfaces (Thread 2).
export * from "./result";
export * from "./errors/domain-error";

// Entities
export * from "./entities/evaluation";
export * from "./entities/evaluation-structure";
export * from "./entities/requirement";
export * from "./entities/procurement-response";

// Ports
export * from "./ports/evaluation-repository";
export * from "./ports/financial-extractor";
export * from "./ports/procurement-classifier";
export * from "./ports/procurement-extraction-reader";
