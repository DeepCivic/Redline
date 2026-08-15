-- redline_ schema — carry each chunk's cut-from element range (delivery-plan
-- "Chunk element addressing").
--
-- redline_money_spans addresses a figure as (document_id, parent_element_order,
-- row_index, column_index) for a table/sheet cell, or (document_id, start_char,
-- end_char) for narrative prose. redline_chunks carried only
-- (source_hash, chunk_index), so the join was document-level: a figure resolved
-- to its document's whole chunk set, never to the one chunk its text actually
-- falls inside.
--
-- womblex's own *.chunks.parquet already carries this
-- (services/womblex/src/womblex/store/output.py CHUNKS_SCHEMA @ v0.3.0):
-- start_char/end_char for every chunk (the same reassemble_narrative coordinate
-- space money's narrative locus reads), and elem_order for table chunks only —
-- null for a narrative chunk (it straddles several elements) and for a
-- spreadsheet-sheet table chunk (no single anchor element).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so re-running is a no-op.

ALTER TABLE "redline_chunks" ADD COLUMN IF NOT EXISTS "start_char" integer;
ALTER TABLE "redline_chunks" ADD COLUMN IF NOT EXISTS "end_char" integer;
ALTER TABLE "redline_chunks" ADD COLUMN IF NOT EXISTS "element_order" integer;

-- The table-chunk address path: resolving a table_cell/sheet_cell money span to
-- its chunk filters on (evaluation_id, source_hash, element_order).
CREATE INDEX IF NOT EXISTS "redline_chunks_element_order_idx"
	ON "redline_chunks" ("evaluation_id", "source_hash", "element_order");
