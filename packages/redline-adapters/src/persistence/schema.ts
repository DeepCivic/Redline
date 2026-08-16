// The redline_ Postgres schema (redline owns its own Postgres). Every table uses
// the redline_ prefix (enforced by validate.sh #6), snake_case columns, and the
// id / created_at / updated_at convention inherited from Wayfinder (CLAUDE.md).
//
// Every table here holds what a womblex run landed — money spans, chunks and the
// enrichment graph. Nothing models a judgement over a corpus; the Evaluation
// aggregate and the comprehension lens were dropped in the pivot to a
// corpus-ingest-and-report substrate (migration 0007).
//
// Kept free of any domain import: this is the storage shape, narrowed to domain
// rows by each store adapter.

import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

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
  evaluationId: text("evaluation_id").notNull(),
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
    // The element range this chunk was cut from (delivery-plan "Chunk element
    // addressing"), mirroring womblex's own CHUNKS_SCHEMA columns byte-for-byte
    // (services/womblex/src/womblex/store/output.py) so a money span resolves to
    // the one chunk containing it instead of to its whole document. A narrative
    // chunk carries startChar/endChar (offsets into the reassembled narrative,
    // the same coordinate space redline_money_spans' narrative locus reads) and
    // null elementOrder (it straddles several elements); a table chunk carries
    // elementOrder (the table element it came from — null for a spreadsheet-sheet
    // table chunk, which has no single anchor element) and null startChar/endChar
    // (its offsets are into table markdown, not narrative).
    startChar: integer("start_char"),
    endChar: integer("end_char"),
    elementOrder: integer("element_order"),
    embedding: jsonb("embedding"),
    embeddingModel: text("embedding_model"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.evaluationId, table.chunkId] }),
  }),
);

export type ChunkRow = typeof redlineChunks.$inferSelect;
export type NewChunkRow = typeof redlineChunks.$inferInsert;

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
