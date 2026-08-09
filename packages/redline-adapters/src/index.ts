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
export {
  WomblexExtractionReader,
  type HttpClient,
  type HttpResponse,
  type WomblexExtractionReaderOptions,
} from "./womblex/womblex-extraction-reader";
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
// The money-span query surface (delivery-plan §2 item 1, ADR-0017/0018): a
// store-backed IMoneySpanStore over womblex's `money` sidecar, materialised into
// the redline_ schema. Addressable pricing facts, no requirement alignment.
export {
  DrizzleMoneySpanStore,
} from "./persistence/drizzle-money-span-store";
// The chunk store (delivery-plan §2 item 1, ADR-0017/0018): the store-side
// query surface over redline_chunks, which the womblex-ingest sidecar's load
// path writes and this adapter reads. Exact fetch + structural fetch; the domain
// ChunkRow carries no vector (ADR-0017), and findSimilar refuses with
// NOT_IMPLEMENTED until the pgvector/ANN index lands (ADR-0018 addendum).
export { DrizzleChunkStore } from "./persistence/drizzle-chunk-store";
export { DrizzleStagedCorpusReader } from "./persistence/drizzle-staged-corpus-reader";
// The persisted lens (delivery-plan §2 item 1, ADR-0009/ADR-0020): the reader
// behind IClassificationLensReader, over redline_lenses / redline_topics /
// redline_hard_rules / redline_lens_bindings. Topics and rules are read from the
// store; `candidates` are derived per call by the identifier-token pre-pass,
// which is this adapter's second collaborator.
export {
  DrizzleClassificationLensReader,
  type DrizzleClassificationLensReaderDependencies,
} from "./persistence/drizzle-classification-lens-reader";
// The write half, over the same four tables: the minimum that lets the corpus
// driver seed the lens it is about to classify against. Whole-lens, transactional
// and idempotent per lens, so a re-run replaces rather than colliding with the
// one-lens-per-evaluation index. Not the authoring surface (deferred).
export { DrizzleClassificationLensWriter } from "./persistence/drizzle-classification-lens-writer";
export {
  makeExtractionHardRuleCandidateDeriver,
  type DeriveHardRuleCandidates,
} from "./lens/hard-rule-candidate-deriver";
// The adjudication seam (ADR-0008 cold-start leg): an IAdjudicator over an
// OpenAI-style chat/completions LLM endpoint. It settles what hard rules and
// structural fetch left unclear — the model picks one candidate topic and gives
// a one-sentence rationale, and may never invent an off-list topic.
export {
  HttpAdjudicator,
  type AdjudicatorHttpClient,
  type AdjudicatorHttpRequest,
  type AdjudicatorHttpResponse,
  type HttpAdjudicatorOptions,
} from "./adjudication/http-adjudicator";
export {
  createRedlinePostgres,
  schema as redlineSchema,
  type RedlinePostgresDatabase,
  type RedlinePostgresOptions,
} from "./persistence/db";
export { applyMigrations, MIGRATION_FILES } from "./persistence/apply-migrations";
