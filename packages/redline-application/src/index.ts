// @redline/redline-application — orchestration use-cases.
//
// Each use-case composes redline-domain ports (extraction reader, classifier,
// financial extractor, language model, evaluation repository) into one step of
// the specialist workflow (build plan §5). No frameworks, no ORMs, no AI SDKs —
// the ports are injected, so every use-case is unit-testable with in-memory
// fakes. Wiring lives in the app's container.
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

// Cold-start classification (item 1b) — the untrained first-pass
// IProcurementClassifier: hard rules + LLM adjudication over the store's
// exact/structural fetch (ADR-0008 / ADR-0018 addendum). No Numbatch, no trained
// adapter, no nearest-neighbour step. Satisfies the same port the trained
// overlay does, so consumers cannot tell which path ran.
export { ColdStartClassifier } from "./use-cases/cold-start-classifier";
export type { ColdStartClassifierDependencies } from "./use-cases/cold-start-classifier";

// Comprehension lens — first-pass classification. The deterministic
// hard-rule pre-pass that resolves before, and in front of, the model.
export { ClassifyWithHardRules } from "./use-cases/classify-with-hard-rules";
export type {
  ClassifyWithHardRulesDependencies,
  ClassifyWithHardRulesInput,
} from "./use-cases/classify-with-hard-rules";

// Comprehension lens — first-pass classification. Model-free
// retrieval: rank chunk vectors against topic definitions by cosine similarity.
export { ClassifyByRetrieval } from "./use-cases/classify-by-retrieval";
export type {
  ClassifyByRetrievalDependencies,
  ClassifyByRetrievalInput,
} from "./use-cases/classify-by-retrieval";

// Comprehension lens — first-pass classification. LLM adjudication:
// choose among the contending topics for what retrieval left unclear, and carry
// the model's one-sentence rationale alongside the shared classification shape.
export { AdjudicateUnclear } from "./use-cases/adjudicate-unclear";
export type {
  AdjudicateUnclearDependencies,
  AdjudicateUnclearInput,
  AdjudicatedClassification,
  UnclearDocument,
} from "./use-cases/adjudicate-unclear";

// Comprehension lens — Document Map read model. A derived,
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

// The real IFinancialExtractor (delivery-plan §2 item 1): reads womblex's money
// spans (IMoneySpanStore) and attributes a document's summed AUD to the
// requirement its classification matched with the highest confidence. This is
// what puts real currency in the review grid.
export { MoneySpanFinancialExtractor } from "./use-cases/money-span-financial-extractor";
export type { MoneySpanFinancialExtractorDependencies } from "./use-cases/money-span-financial-extractor";

export { BuildEvaluationTable } from "./use-cases/build-evaluation-table";
export type {
  BuildEvaluationTableDependencies,
  BuildEvaluationTableInput,
} from "./use-cases/build-evaluation-table";
