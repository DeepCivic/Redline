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

// Comprehension lens (Thread 17) — durable, evaluation-independent.
export * from "./entities/topic";
export * from "./entities/lens";
export * from "./entities/lens-projection";

// Hard rules (Thread 18) — deterministic pattern -> topic, resolved before any model.
export * from "./entities/hard-rule";
export * from "./entities/hard-rule-evaluation";

// Ports
export * from "./ports/evaluation-repository";
export * from "./ports/financial-extractor";
export * from "./ports/language-model";
export * from "./ports/procurement-classifier";
export * from "./ports/procurement-extraction-reader";
