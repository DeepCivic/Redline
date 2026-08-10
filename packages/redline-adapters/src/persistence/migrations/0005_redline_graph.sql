-- redline_ schema — enrichment graph store (ADR-0017/0018).
-- womblex's `enrich` output materialised into redline's own Postgres, addressed by
-- provenance and traversed in place. This is the report assembler's navigation
-- mechanic (ADR-0017): entity → mentioned_in edge → chunk → verbatim text — NOT
-- vector search. The graph LOCATES the right source rows; the transfer itself is
-- still an exact chunk fetch through redline_chunks.
--
-- Two tables mirror womblex's two enrich sidecars column for column
-- (services/womblex/src/womblex/store/enrichment_output.py):
--   redline_graph_entities  ← ENTITY_SCHEMA      (*.enrichment_entities.parquet)
--   redline_graph_edges     ← GRAPH_EDGE_SCHEMA  (*.graph_edges.parquet)
-- with `document_id` carrying the source_hash in both, exactly as the sharded
-- enrich layout writes it, so the graph joins to redline_chunks on
-- (evaluation_id, document_id, chunk_index).
--
-- As with redline_chunks, the SIDECAR's load path writes these tables and the
-- DrizzleGraphStore only reads them — so this DDL is the shape the two share.
-- Availability is a runtime condition (delivery-plan §2): enrich is Isaacus spend
-- and may not have run, in which case these tables are simply empty and every read
-- is an empty result — never an error. Hand-authored to mirror
-- src/persistence/schema.ts and kept idempotent.

CREATE TABLE IF NOT EXISTS "redline_graph_entities" (
	"evaluation_id" text NOT NULL,
	"document_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_label" text NOT NULL,
	"name" text NOT NULL,
	"entity_type" text DEFAULT '' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"mention_start" integer NOT NULL,
	"mention_end" integer NOT NULL,
	-- womblex writes -1 when a mention did not map to a chunk (AI chunking before
	-- the graph refresh), so a consumer treats -1 as "no chunk", not chunk 0.
	"chunk_index" integer NOT NULL,
	-- An entity mentions itself many times, so (entity_id, mention_start) is the
	-- natural key within a document — but womblex re-emits an id across split
	-- segments, so the mention offset disambiguates.
	PRIMARY KEY ("evaluation_id", "document_id", "entity_id", "mention_start")
);

CREATE TABLE IF NOT EXISTS "redline_graph_edges" (
	"evaluation_id" text NOT NULL,
	"document_id" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"relation" text NOT NULL,
	-- womblex flattens edge properties to one row per (edge, property) pair, so a
	-- property-less edge is a single row with empty prop_key/prop_value and a
	-- multi-property edge repeats across rows. The property key is therefore part
	-- of the key: without it the second property row collides with the first.
	"prop_key" text DEFAULT '' NOT NULL,
	"prop_value" text DEFAULT '' NOT NULL,
	PRIMARY KEY ("evaluation_id", "document_id", "source_id", "target_id", "relation", "prop_key")
);

-- The traversal access paths. Entities are filtered by (document, label) and
-- reverse-addressed by the chunk they fall in; edges are followed out of a source
-- node and into a target node.
CREATE INDEX IF NOT EXISTS "redline_graph_entities_document_idx"
	ON "redline_graph_entities" ("evaluation_id", "document_id", "entity_label");

CREATE INDEX IF NOT EXISTS "redline_graph_entities_chunk_idx"
	ON "redline_graph_entities" ("evaluation_id", "chunk_index");

CREATE INDEX IF NOT EXISTS "redline_graph_edges_from_idx"
	ON "redline_graph_edges" ("evaluation_id", "source_id");

CREATE INDEX IF NOT EXISTS "redline_graph_edges_to_idx"
	ON "redline_graph_edges" ("evaluation_id", "target_id");
