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
  text,
  timestamp,
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

// One `locus='table_cell'` money span, materialised from womblex's
// `*.money_spans.parquet` (ADR-0017 — bulk columnar data lives in redline's own
// store, queried in place). Keyed on the womblex provenance the span was
// annotated against: (evaluation, source_hash, parent_elem_order, row, col).
// `value` is `numeric(38, 4)` — the exact `Decimal` womblex writes, never a
// float, so summing amounts and reconciling for equality stay exact. `currency`
// is nullable: a span can be money-marked with its currency unresolved. The
// sidecar (the one reader of womblex's Parquet schema) loads this table; the
// DrizzleMoneySpanStore only reads it.
export const redlineMoneySpans = pgTable("redline_money_spans", {
  id: text("id").primaryKey(),
  evaluationId: text("evaluation_id")
    .notNull()
    .references(() => redlineEvaluations.id, { onDelete: "cascade" }),
  documentId: text("document_id").notNull(),
  parentElementOrder: integer("parent_element_order").notNull(),
  rowIndex: integer("row_index").notNull(),
  columnIndex: integer("column_index").notNull(),
  cellText: text("cell_text").notNull(),
  value: numeric("value", { precision: 38, scale: 4 }).notNull(),
  currency: text("currency"),
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
