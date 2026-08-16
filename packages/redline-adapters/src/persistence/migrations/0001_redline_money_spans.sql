-- redline_ schema — money spans (ADR-0017/0018).
-- One row per `locus='table_cell'` money span, materialised from womblex's
-- `*.money_spans.parquet` into redline's own store so bulk columnar pricing data
-- is queried in place rather than parsed in TypeScript. Hand-authored to mirror
-- src/persistence/schema.ts and kept idempotent (IF NOT EXISTS) so re-running is
-- a no-op. `value` is numeric(38, 4) — the exact Decimal womblex writes, never a
-- float; `currency` is nullable (money-marked, currency unresolved).

CREATE TABLE IF NOT EXISTS "redline_money_spans" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"document_id" text NOT NULL,
	"parent_element_order" integer NOT NULL,
	"row_index" integer NOT NULL,
	"column_index" integer NOT NULL,
	"cell_text" text NOT NULL,
	"value" numeric(38, 4) NOT NULL,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- 0007 drops this constraint along with redline_evaluations, so on any database
-- that has booted since the pivot this ADD is vestigial and must not be fatal.
-- Every migration re-applies on every boot, so 0000 recreates an *empty*
-- redline_evaluations and this statement then re-validates against it: with money
-- spans already loaded, that raises foreign_key_violation rather than
-- duplicate_object, and an untrapped raise here stops the service from starting.
-- Both are swallowed — the constraint is either already present (healthy
-- pre-pivot database) or deliberately absent (post-0007).
DO $$ BEGIN
	ALTER TABLE "redline_money_spans" ADD CONSTRAINT "redline_money_spans_evaluation_id_fk"
		FOREIGN KEY ("evaluation_id") REFERENCES "redline_evaluations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object OR foreign_key_violation THEN null; END $$;

-- The two access paths the store answers: a whole-document read and the
-- structural (document, table element) address. Indexed so both stay cheap as
-- the span count grows with the corpus.
CREATE INDEX IF NOT EXISTS "redline_money_spans_document_idx"
	ON "redline_money_spans" ("evaluation_id", "document_id");

CREATE INDEX IF NOT EXISTS "redline_money_spans_structure_idx"
	ON "redline_money_spans" ("evaluation_id", "document_id", "parent_element_order");
