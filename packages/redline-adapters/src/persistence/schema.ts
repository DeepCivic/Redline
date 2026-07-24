// The redline_ Postgres schema (build plan §4, ADR-0002 — redline owns its own
// Postgres). Every table uses the redline_ prefix (enforced by validate.sh #7),
// snake_case columns, and the id / created_at / updated_at convention inherited
// from Wayfinder (CLAUDE.md). The domain aggregate (Evaluation + its vendors,
// response groups and responses) maps onto these four tables.
//
// Kept free of any domain import: this is the storage shape, mapped to domain
// entities in row-mapping.ts.

import {
  boolean,
  doublePrecision,
  integer,
  numeric,
  pgTable,
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
