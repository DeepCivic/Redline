-- redline_ schema — widen redline_money_spans to womblex's full money span.
--
-- The table was created holding nine columns and one locus (`table_cell`), which
-- cannot hold what womblex's `MONEY_SPANS_SCHEMA` writes
-- (services/womblex/src/womblex/store/money_output.py @ v0.3.0 — 24 columns
-- across three loci). Three of those drops changed behaviour rather than
-- fidelity: the `narrative` locus is where prose amounts live and tenders are
-- predominantly PDFs; `modifier` is the qualifier womblex deliberately never
-- folds into `value`, so without it "up to $2M" persists as exactly $2M; and
-- `range_group`/`range_role` are the only thing separating a range's lower
-- endpoint from its upper.
--
-- These are womblex's own columns copied across, uninterpreted. `locus` becomes a
-- real discriminator and the anchor columns become nullable, because **exactly one
-- anchor group is non-null per row** — womblex's own invariant:
--   narrative   — start_char / end_char (+ page), in the layer text_source names
--   table_cell  — parent_element_order / row_index / column_index
--   sheet_cell  — sheet / row_index / column_index (+ element_order)
--
-- Idempotent (IF NOT EXISTS / trapped exceptions) so re-running is a no-op.

-- Renaming, not adding: a `narrative` span's text is not a cell's. Trapped rather
-- than guarded on a catalogue lookup so the second run is a plain no-op.
DO $$ BEGIN
	ALTER TABLE "redline_money_spans" RENAME COLUMN "cell_text" TO "text";
EXCEPTION WHEN undefined_column THEN null; END $$;

ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "text_source" text;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "start_char" integer;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "end_char" integer;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "page" integer;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "element_order" integer;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "sheet" text;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "currency_source" text;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "evidence" text;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "modifier" text;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "multiplier" text;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "range_group" integer;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "range_role" text;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "column_id" text;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "context" text;

-- The three womblex always writes. Added with a default so ADD COLUMN succeeds on
-- a populated table, then stripped of it so the writer must state each one — a
-- lingering default would let a broken writer land silent zeroes.
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "locus" text NOT NULL DEFAULT 'table_cell';
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "negative" boolean NOT NULL DEFAULT false;
ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "confidence" real NOT NULL DEFAULT 0;
ALTER TABLE "redline_money_spans" ALTER COLUMN "locus" DROP DEFAULT;
ALTER TABLE "redline_money_spans" ALTER COLUMN "negative" DROP DEFAULT;
ALTER TABLE "redline_money_spans" ALTER COLUMN "confidence" DROP DEFAULT;

-- The cell anchors are one locus's, not every row's.
ALTER TABLE "redline_money_spans" ALTER COLUMN "parent_element_order" DROP NOT NULL;
ALTER TABLE "redline_money_spans" ALTER COLUMN "row_index" DROP NOT NULL;
ALTER TABLE "redline_money_spans" ALTER COLUMN "column_index" DROP NOT NULL;

-- The locus access path, new with the discriminator. The (evaluation_id,
-- document_id) and (evaluation_id, document_id, parent_element_order) indexes
-- from 0001 stay: they still back the whole-document read and the table-element
-- address, which is now explicitly a table-cell-only filter.
CREATE INDEX IF NOT EXISTS "redline_money_spans_locus_idx"
	ON "redline_money_spans" ("evaluation_id", "locus");
