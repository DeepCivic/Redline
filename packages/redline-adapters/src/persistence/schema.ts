// The redline_ Postgres schema (build plan §4, ADR-0002 — redline owns its own
// Postgres). Every table uses the redline_ prefix (enforced by validate.sh #7),
// snake_case columns, and the id / created_at / updated_at convention inherited
// from Wayfinder (CLAUDE.md). The domain aggregate (Evaluation + its vendors,
// response groups and responses) maps onto four tables; a fifth,
// redline_money_spans, holds womblex's `money` sidecar materialised into the
// store (ADR-0017) and is not part of the aggregate.
//
// Kept free of any domain import: this is the storage shape, mapped to domain
// entities in row-mapping.ts.

import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// The evaluation aggregate root. `stage` is the IntakeStage enum stored as text
// (the domain validates transitions; the column just persists the current value).
export const redlineEvaluations = pgTable("redline_evaluations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  stage: text("stage").notNull(),
  ...timestamps,
});

// A vendor or consortium. memberVendorIds is only populated for consortiums.
export const redlineVendors = pgTable("redline_vendors", {
  id: text("id").primaryKey(),
  evaluationId: text("evaluation_id")
    .notNull()
    .references(() => redlineEvaluations.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  isConsortium: boolean("is_consortium").notNull().default(false),
  memberVendorIds: text("member_vendor_ids").array().notNull().default([]),
  ...timestamps,
});

// A response group: N vendors × N documents making up one response.
export const redlineResponseGroups = pgTable("redline_response_groups", {
  id: text("id").primaryKey(),
  evaluationId: text("evaluation_id")
    .notNull()
    .references(() => redlineEvaluations.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  vendorIds: text("vendor_ids").array().notNull().default([]),
  documentIds: text("document_ids").array().notNull().default([]),
  isConsortiumResponse: boolean("is_consortium_response").notNull().default(false),
  ...timestamps,
});

// One review-grid row: a (document, matched requirement) pair for a group.
// estimate_aud is numeric (real currency) — nullable when only a description
// fallback was available. source_* carry womblex provenance for the deep-link.
export const redlineResponses = pgTable("redline_responses", {
  id: text("id").primaryKey(),
  evaluationId: text("evaluation_id")
    .notNull()
    .references(() => redlineEvaluations.id, { onDelete: "cascade" }),
  responseGroupId: text("response_group_id").notNull(),
  vendorName: text("vendor_name").notNull(),
  productName: text("product_name").notNull(),
  requirementId: text("requirement_id").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  productSummary: text("product_summary").notNull(),
  estimateAud: numeric("estimate_aud", { precision: 18, scale: 2 }),
  costDescription: text("cost_description").notNull().default(""),
  sourceDocumentId: text("source_document_id").notNull(),
  sourceElementOrder: integer("source_element_order").notNull(),
  sourcePage: integer("source_page"),
  sourceChunkId: text("source_chunk_id"),
  ...timestamps,
});

export type EvaluationRow = typeof redlineEvaluations.$inferSelect;
export type NewEvaluationRow = typeof redlineEvaluations.$inferInsert;
export type VendorRow = typeof redlineVendors.$inferSelect;
export type NewVendorRow = typeof redlineVendors.$inferInsert;
export type ResponseGroupRow = typeof redlineResponseGroups.$inferSelect;
export type NewResponseGroupRow = typeof redlineResponseGroups.$inferInsert;
export type ResponseRow = typeof redlineResponses.$inferSelect;
export type NewResponseRow = typeof redlineResponses.$inferInsert;

// One money span, materialised from womblex's `*.money_spans.parquet` (ADR-0017 —
// bulk columnar data lives in redline's own store, queried in place). This mirrors
// womblex's `MONEY_SPANS_SCHEMA` column for column, uninterpreted: three loci
// discriminated by `locus`, with **exactly one anchor group non-null per row**
// (narrative → start_char/end_char; table_cell → parent_element_order/row/column;
// sheet_cell → sheet/row/column + element_order), which is why every anchor is
// nullable. `value` is `numeric(38, 4)` — the exact `Decimal` womblex writes, never
// a float, so summing amounts and reconciling for equality stay exact, and it
// arrives with the magnitude suffix and sign already applied. `currency` is
// nullable: a span can be money-marked with its currency unresolved. The sidecar
// (the one reader of womblex's Parquet schema) loads this table; the
// DrizzleMoneySpanStore only reads it.
export const redlineMoneySpans = pgTable("redline_money_spans", {
  id: text("id").primaryKey(),
  evaluationId: text("evaluation_id")
    .notNull()
    .references(() => redlineEvaluations.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull(),
  locus: text("locus").notNull(),
  textSource: text("text_source"),
  startChar: integer("start_char"),
  endChar: integer("end_char"),
  page: integer("page"),
  elementOrder: integer("element_order"),
  parentElementOrder: integer("parent_element_order"),
  sheet: text("sheet"),
  rowIndex: integer("row_index"),
  columnIndex: integer("column_index"),
  text: text("text").notNull(),
  value: numeric("value", { precision: 38, scale: 4 }).notNull(),
  currency: text("currency"),
  currencySource: text("currency_source"),
  evidence: text("evidence"),
  modifier: text("modifier"),
  multiplier: text("multiplier"),
  negative: boolean("negative").notNull(),
  // `real`, not `doublePrecision`: womblex's column is float32, so this holds its
  // bits exactly. The decimal spelling differs either side of the seam (Python
  // widens the bits to print 0.8999999761581421; Postgres renders the shortest
  // round-trip form, 0.9) — same value, so compare confidences at float32.
  confidence: real("confidence").notNull(),
  rangeGroup: integer("range_group"),
  rangeRole: text("range_role"),
  columnId: text("column_id"),
  context: text("context"),
  ...timestamps,
});

export type MoneySpanRow = typeof redlineMoneySpans.$inferSelect;
export type NewMoneySpanRow = typeof redlineMoneySpans.$inferInsert;

// The ADR-0018 chunk store: womblex's chunks + embeddings materialised into
// redline's own Postgres (ADR-0017), addressed by provenance and returned
// byte-identical. WRITTEN by the womblex-ingest sidecar's load path (the one
// reader of womblex's Parquet schema — chunk_store_postgres.py); this schema is
// the TypeScript-side view the DrizzleChunkStore READS. It must mirror the
// sidecar's REDLINE_CHUNK_STORE_DDL exactly — no `id`/timestamps, a composite
// (evaluation_id, chunk_id) primary key, and `chunk_id` == "{source_hash}:{index}".
//
// The embedding rides as `embedding jsonb` (a plain float array) + `embedding_model`
// — loaded and available (ADR-0018 addendum), NOT under a pgvector column or an
// ANN index. It is deliberately absent from the domain ChunkRow: no vector
// crosses the seam (ADR-0017), so this adapter never selects it.
export const redlineChunks = pgTable(
  "redline_chunks",
  {
    evaluationId: text("evaluation_id").notNull(),
    chunkId: text("chunk_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    contentType: text("content_type").notNull().default("narrative"),
    page: integer("page"),
    text: text("text").notNull(),
    embedding: jsonb("embedding"),
    embeddingModel: text("embedding_model"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.evaluationId, table.chunkId] }),
  }),
);

export type ChunkRow = typeof redlineChunks.$inferSelect;
export type NewChunkRow = typeof redlineChunks.$inferInsert;

// The comprehension lens, persisted (ADR-0009 for the shape, ADR-0020 for the
// ownership of definition text). Four tables, because a lens is a durable asset
// that outlives any one evaluation: the lens itself, its topics, its hard rules,
// and the binding that applies it to an evaluation.

// The durable asset. Carries no evaluation_id — binding it to an evaluation is
// redline_lens_bindings' job, not a column here (ADR-0009).
export const redlineLenses = pgTable("redline_lenses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
});

// A lens's topics, each with the prose definition ColdStartClassifier hands the
// adjudicator. The definition text is redline's own data on the cold-start path
// (ADR-0020) — Numbatch's library is the system of record only for the trained
// overlay's topics, samples and corrections.
//
// `position` exists because the domain's Topic list is ordered and the reader
// must return it byte-identical; without an explicit column the row order is
// whatever Postgres returns.
export const redlineTopics = pgTable("redline_topics", {
  id: text("id").primaryKey(),
  lensId: text("lens_id")
    .notNull()
    .references(() => redlineLenses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  definition: text("definition").notNull(),
  position: integer("position").notNull(),
  ...timestamps,
});

// Declaration order is load-bearing: it is the tie-break between two rules of
// equal specificity (ADR-0011), so it is stored rather than left to row order.
export const redlineHardRules = pgTable("redline_hard_rules", {
  id: text("id").primaryKey(),
  lensId: text("lens_id")
    .notNull()
    .references(() => redlineLenses.id, { onDelete: "cascade" }),
  pattern: text("pattern").notNull(),
  topicId: text("topic_id")
    .notNull()
    .references(() => redlineTopics.id, { onDelete: "cascade" }),
  declarationOrder: integer("declaration_order").notNull(),
  ...timestamps,
});

// The lens↔evaluation binding, its own row (ADR-0009). One lens per evaluation:
// the classifier resolves exactly one lens per call, so a second binding would
// make that resolution ambiguous.
export const redlineLensBindings = pgTable(
  "redline_lens_bindings",
  {
    id: text("id").primaryKey(),
    lensId: text("lens_id")
      .notNull()
      .references(() => redlineLenses.id, { onDelete: "cascade" }),
    evaluationId: text("evaluation_id")
      .notNull()
      .references(() => redlineEvaluations.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => ({
    oneLensPerEvaluation: uniqueIndex("redline_lens_bindings_evaluation_idx").on(
      table.evaluationId,
    ),
  }),
);

export type LensRow = typeof redlineLenses.$inferSelect;
export type NewLensRow = typeof redlineLenses.$inferInsert;
export type TopicRow = typeof redlineTopics.$inferSelect;
export type NewTopicRow = typeof redlineTopics.$inferInsert;
export type HardRuleRow = typeof redlineHardRules.$inferSelect;
export type NewHardRuleRow = typeof redlineHardRules.$inferInsert;
export type LensBindingRow = typeof redlineLensBindings.$inferSelect;
export type NewLensBindingRow = typeof redlineLensBindings.$inferInsert;

// The enrichment graph, materialised from womblex's `enrich` sidecars (ADR-0017/
// 0018): entity mentions (`*.enrichment_entities.parquet` → ENTITY_SCHEMA) and
// directed edges (`*.graph_edges.parquet` → GRAPH_EDGE_SCHEMA), each column mirrored
// with `document_id` carrying the source_hash. WRITTEN by the womblex-ingest
// sidecar's load path; this schema is the TypeScript-side view the DrizzleGraphStore
// READS. The report assembler traverses it (entity → mentioned_in edge → chunk →
// verbatim text); a graph that never loaded is an empty table, not an error.
export const redlineGraphEntities = pgTable(
  "redline_graph_entities",
  {
    evaluationId: text("evaluation_id").notNull(),
    documentId: text("document_id").notNull(),
    entityId: text("entity_id").notNull(),
    entityLabel: text("entity_label").notNull(),
    name: text("name").notNull(),
    entityType: text("entity_type").notNull().default(""),
    role: text("role").notNull().default(""),
    mentionStart: integer("mention_start").notNull(),
    mentionEnd: integer("mention_end").notNull(),
    // womblex writes -1 when a mention did not map to a chunk.
    chunkIndex: integer("chunk_index").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.evaluationId, table.documentId, table.entityId, table.mentionStart],
    }),
  }),
);

export const redlineGraphEdges = pgTable(
  "redline_graph_edges",
  {
    evaluationId: text("evaluation_id").notNull(),
    documentId: text("document_id").notNull(),
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
    relation: text("relation").notNull(),
    // womblex flattens edge properties to one row per (edge, property) pair.
    propKey: text("prop_key").notNull().default(""),
    propValue: text("prop_value").notNull().default(""),
  },
  (table) => ({
    pk: primaryKey({
      columns: [
        table.evaluationId,
        table.documentId,
        table.sourceId,
        table.targetId,
        table.relation,
        table.propKey,
      ],
    }),
  }),
);

export type GraphEntityRow = typeof redlineGraphEntities.$inferSelect;
export type NewGraphEntityRow = typeof redlineGraphEntities.$inferInsert;
export type GraphEdgeRow = typeof redlineGraphEdges.$inferSelect;
export type NewGraphEdgeRow = typeof redlineGraphEdges.$inferInsert;
