// @redline/redline-application — orchestration use-cases (Thread 10).
//
// Each use-case composes redline-domain ports (extraction reader, classifier,
// financial extractor, language model, evaluation repository) into one step of
// the specialist workflow (build plan §5). No frameworks, no ORMs, no AI SDKs —
// the ports are injected, so every use-case is unit-testable with in-memory
// fakes. Wiring lives in the app's container (Thread 11).
export { IngestDocuments } from "./use-cases/ingest-documents";
export type {
  IngestDocumentsDependencies,
  IngestDocumentsInput,
} from "./use-cases/ingest-documents";

export { AssignDocumentsToGroups } from "./use-cases/assign-documents-to-groups";
export type {
  AssignDocumentsToGroupsDependencies,
  AssignDocumentsToGroupsInput,
  ResponseGroupInput,
  VendorInput,
} from "./use-cases/assign-documents-to-groups";

export { ClassifyResponseGroup } from "./use-cases/classify-response-group";
export type { ClassifyResponseGroupDependencies } from "./use-cases/classify-response-group";

// Comprehension lens — first-pass classification (Thread 21). The deterministic
// hard-rule pre-pass that resolves before, and in front of, the model.
export { ClassifyWithHardRules } from "./use-cases/classify-with-hard-rules";
export type {
  ClassifyWithHardRulesDependencies,
  ClassifyWithHardRulesInput,
} from "./use-cases/classify-with-hard-rules";

// Comprehension lens — first-pass classification (Thread 22). Model-free
// retrieval: rank chunk vectors against topic definitions by cosine similarity.
export { ClassifyByRetrieval } from "./use-cases/classify-by-retrieval";
export type {
  ClassifyByRetrievalDependencies,
  ClassifyByRetrievalInput,
} from "./use-cases/classify-by-retrieval";

// Comprehension lens — first-pass classification (Thread 23). LLM adjudication:
// choose among the contending topics for what retrieval left unclear, and carry
// the model's one-sentence rationale alongside the shared classification shape.
export { AdjudicateUnclear } from "./use-cases/adjudicate-unclear";
export type {
  AdjudicateUnclearDependencies,
  AdjudicateUnclearInput,
  AdjudicatedClassification,
  UnclearDocument,
} from "./use-cases/adjudicate-unclear";

// Comprehension lens — Document Map read model (Thread 25). A derived,
// never-stored roll-up of how the corpus sorted across topics (counts + shares)
// and the corpus-wide Clear/Ambiguous split. Reuses computePivot's algorithm,
// not its types (Thread 13's precedent); carries no confidence value (§8).
export { buildDocumentMap } from "./use-cases/build-document-map";
export type {
  DocumentMap,
  DocumentMapEntry,
  MappedDocument,
} from "./use-cases/build-document-map";

export { ExtractFinancials } from "./use-cases/extract-financials";
export type { ExtractFinancialsDependencies } from "./use-cases/extract-financials";

export { BuildEvaluationTable } from "./use-cases/build-evaluation-table";
export type {
  BuildEvaluationTableDependencies,
  BuildEvaluationTableInput,
} from "./use-cases/build-evaluation-table";
