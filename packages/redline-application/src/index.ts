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

export { ExtractFinancials } from "./use-cases/extract-financials";
export type { ExtractFinancialsDependencies } from "./use-cases/extract-financials";

export { BuildEvaluationTable } from "./use-cases/build-evaluation-table";
export type {
  BuildEvaluationTableDependencies,
  BuildEvaluationTableInput,
} from "./use-cases/build-evaluation-table";
