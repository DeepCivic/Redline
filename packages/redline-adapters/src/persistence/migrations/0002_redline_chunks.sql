-- redline_ schema — chunk store (ADR-0017/0018).
-- womblex's chunks + embeddings materialised into redline's own Postgres,
-- addressed by provenance and returned byte-identical, so the classifier reads
-- passages in place rather than being shipped bulk JSON vectors (ADR-0014's
-- 50k-chunk trigger ruled that out at the measured ~90k-chunk corpus).
--
-- This mirrors the womblex-ingest sidecar's REDLINE_CHUNK_STORE_DDL
-- (chunk_store_postgres.py) byte-for-byte: the SIDECAR writes this table, this
-- adapter reads it, so the two share one shape. No id/timestamps; the composite
-- (evaluation_id, chunk_id) is the primary key; chunk_id == "{source_hash}:{index}".
--
-- The embedding rides as `embedding jsonb` + `embedding_model` — loaded and
-- available (ADR-0018 addendum), NOT under a pgvector column or an ANN index.
-- Enabling similarity search later is ALTER TABLE ... ADD COLUMN embedding
-- vector(...) + an index build over data already present, a separate release.
-- Hand-authored to mirror src/persistence/schema.ts and kept idempotent.

CREATE TABLE IF NOT EXISTS "redline_chunks" (
	"evaluation_id" text NOT NULL,
	"chunk_id" text NOT NULL,
	"source_hash" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content_type" text DEFAULT 'narrative' NOT NULL,
	"page" integer,
	"text" text NOT NULL,
	"embedding" jsonb,
	"embedding_model" text,
	PRIMARY KEY ("evaluation_id", "chunk_id")
);

-- The two access paths the store answers: structural addressing by
-- (document, chunk_index) and a content_type narrow. Indexed so both stay cheap
-- as the chunk count grows to the ~90k-chunk corpus.
CREATE INDEX IF NOT EXISTS "redline_chunks_structure_idx"
	ON "redline_chunks" ("evaluation_id", "source_hash", "chunk_index");

CREATE INDEX IF NOT EXISTS "redline_chunks_content_type_idx"
	ON "redline_chunks" ("evaluation_id", "content_type");
