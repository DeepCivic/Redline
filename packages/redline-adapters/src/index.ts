// @redline/redline-adapters — port implementations against real systems.
//
// Thread 4: WomblexExtractionReader implements IProcurementExtractionReader over
// the womblex-ingest sidecar's Parquet→JSON read seam.
// Thread 5: NumbatchClassifier implements IProcurementClassifier over the
// Numbatch batch-inference API (topic_id → requirementId).
// Thread 8: NumbatchFinancialExtractor implements IFinancialExtractor over the
// financial extension's read seam (topic_id → requirementId; currency numeric).
// Thread 9: DrizzleEvaluationRepository implements IEvaluationRepository over the
// redline_ Postgres schema (ADR-0002).
// Thread 20: WomblexEmbeddingReader implements IEmbeddingReader over the
// womblex-ingest sidecar's retrieval read seam (Float32Array; cached per
// evaluation — ADR-0014).
export {
  WomblexExtractionReader,
  type HttpClient,
  type HttpResponse,
  type WomblexExtractionReaderOptions,
} from "./womblex/womblex-extraction-reader";
export {
  WomblexEmbeddingReader,
  type HttpClient as WomblexEmbeddingHttpClient,
  type HttpResponse as WomblexEmbeddingHttpResponse,
  type WomblexEmbeddingReaderOptions,
} from "./embeddings/womblex-embedding-reader";
export {
  NumbatchClassifier,
  type HttpClient as NumbatchHttpClient,
  type HttpRequest as NumbatchHttpRequest,
  type HttpResponse as NumbatchHttpResponse,
  type NumbatchClassifierOptions,
  type NumbatchProfileBinding,
} from "./numbatch/numbatch-classifier";
export {
  NumbatchFinancialExtractor,
  type HttpClient as NumbatchFinancialHttpClient,
  type HttpResponse as NumbatchFinancialHttpResponse,
  type NumbatchFinancialExtractorOptions,
  type NumbatchProfileBinding as NumbatchFinancialProfileBinding,
} from "./numbatch/numbatch-financial-extractor";
export {
  DrizzleEvaluationRepository,
} from "./persistence/drizzle-evaluation-repository";
export {
  createRedlinePostgres,
  schema as redlineSchema,
  type RedlinePostgresDatabase,
  type RedlinePostgresOptions,
} from "./persistence/db";
export { applyMigrations, MIGRATION_FILES } from "./persistence/apply-migrations";
