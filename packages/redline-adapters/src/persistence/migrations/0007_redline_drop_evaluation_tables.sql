-- redline_ schema — drop the Evaluation surface.
--
-- redline is a corpus-ingest-and-report substrate: it stages a corpus, drives
-- the womblex run over it, and serves the rows that run lands. The Evaluation
-- aggregate and the comprehension lens it was classified through are gone, so
-- their eight tables go with them. What survives is what a run writes —
-- redline_chunks, redline_money_spans, redline_graph_entities and
-- redline_graph_edges.
--
-- Migrations here are forward-only and re-applied on every boot, so 0000-0003
-- still create these tables and this file still drops them on every boot. An
-- operator's database therefore reaches the same end state whether it was first
-- migrated before or after the pivot.
--
-- That re-apply cycle is why 0001's money-span FK now also traps
-- foreign_key_violation: the boot after this file first runs, 0000 recreates an
-- empty redline_evaluations and 0001 re-validates the FK against it, which a
-- loaded redline_money_spans cannot satisfy.
--
-- redline_money_spans survives but carried an FK into redline_evaluations, so
-- that constraint is dropped explicitly rather than left to CASCADE — a drop of
-- a doomed table must not reach into a surviving one by side effect.

ALTER TABLE IF EXISTS "redline_money_spans"
	DROP CONSTRAINT IF EXISTS "redline_money_spans_evaluation_id_fk";

-- Dependents before their parents, so each drop stands on its own without
-- CASCADE.
DROP TABLE IF EXISTS "redline_lens_bindings";
DROP TABLE IF EXISTS "redline_hard_rules";
DROP TABLE IF EXISTS "redline_topics";
DROP TABLE IF EXISTS "redline_lenses";
DROP TABLE IF EXISTS "redline_responses";
DROP TABLE IF EXISTS "redline_response_groups";
DROP TABLE IF EXISTS "redline_vendors";
DROP TABLE IF EXISTS "redline_evaluations";
