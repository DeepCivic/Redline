// @redline/redline-adapters — port implementations against real systems.
//
// Two systems, and no third: the womblex engine (its sidecar's read, trigger and
// status seams, plus the object store a run reads its input from) and redline's
// own Postgres, where the rows a run lands are queried in place.
export {
  WomblexExtractionReader,
  type HttpClient,
  type HttpResponse,
  type WomblexExtractionReaderOptions,
} from "./womblex/womblex-extraction-reader";
// The run-trigger seam (architecture §3/§5): redline's second coupling to the
// womblex engine, over the sidecar's `POST /runs` / `GET /runs/{runId}` /
// `POST /runs/{runId}/resume` endpoints. Triggers a run and reads its state;
// redline does not reimplement the engine's batching, retry or scale-out.
export {
  HttpWomblexRunTrigger,
  type RunTriggerHttpClient,
  type RunTriggerHttpRequest,
  type RunTriggerHttpResponse,
  type HttpWomblexRunTriggerOptions,
} from "./womblex/http-womblex-run-trigger";
// The money-span query surface: a store-backed IMoneySpanStore
// over womblex's `money` sidecar, materialised into the redline_ schema by the
// sidecar's load path. Addressable financial expressions as womblex wrote them —
// all three loci, no roll-up, nothing interpreted.
export { DrizzleMoneySpanStore } from "./persistence/drizzle-money-span-store";
// The chunk store: the store-side query surface over redline_chunks, which the
// womblex-ingest sidecar's load path writes and this adapter reads. Exact fetch
// + structural fetch; the domain ChunkRow carries no vector, and findSimilar
// refuses with NOT_IMPLEMENTED until the pgvector/ANN index lands.
export { DrizzleChunkStore } from "./persistence/drizzle-chunk-store";
// Chunk element addressing: resolves a money span to the single chunk whose
// element range contains it, given the candidate chunks a
// caller already fetched (typically fetchByStructure({ documentId })). Pure —
// no store — since both operands are already-fetched domain rows.
export { resolveChunkForMoneySpan } from "./persistence/chunk-element-resolution";
// The enrichment-graph store: the report assembler's navigation
// surface over redline_graph_entities / redline_graph_edges, which the
// womblex-ingest sidecar's enrich load path writes and this adapter reads. Entity
// filtering + edge traversal in both directions; the graph LOCATES source rows,
// the transfer itself stays an exact chunk fetch. A graph that never loaded is an
// empty table, so every read is an empty result rather than an error.
export { DrizzleGraphStore } from "./persistence/drizzle-graph-store";
export { DrizzleStagedCorpusReader } from "./persistence/drizzle-staged-corpus-reader";
// The write side of the object-store seam: redline's first write-side adapter,
// putting a specialist's chosen bytes under `proc/{evaluationId}/inputs/` in
// redline's own bucket — the prefix the womblex runner reads its input from.
// Client-injected so it is testable without a bucket; createStagedCorpusWriter
// is the production wiring that builds the real minio client from config.
export {
  MinioStagedCorpusWriter,
  type StagedCorpusPutClient,
  type MinioStagedCorpusWriterOptions,
} from "./storage/minio-staged-corpus-writer";
export { createStagedCorpusWriter, type RedlineStorageOptions } from "./storage/redline-storage";
export {
  createRedlinePostgres,
  schema as redlineSchema,
  type RedlinePostgresDatabase,
  type RedlinePostgresOptions,
} from "./persistence/db";
export { applyMigrations, MIGRATION_FILES } from "./persistence/apply-migrations";
