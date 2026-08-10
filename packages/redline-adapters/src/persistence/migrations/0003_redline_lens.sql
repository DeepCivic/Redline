-- redline_ schema — the persisted comprehension lens.
-- ADR-0009 puts the lens, its hard rules and its bindings in redline_ tables;
-- ADR-0020 settles that the cold-start topic DEFINITION text is redline-owned
-- too, because ColdStartClassifier adjudicates over that prose and the lean
-- vertical runs with no Numbatch to dereference.
--
-- Four tables, not three: a lens with no topics gives the adjudicator nothing to
-- choose among (indexLens maps every topic.definition into an
-- AdjudicationCandidate), so redline_topics is load-bearing, not optional.
--
-- Hand-authored to mirror src/persistence/schema.ts and kept idempotent.

CREATE TABLE IF NOT EXISTS "redline_lenses" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- `position` keeps the domain's ordered Topic list readable byte-identical;
-- without it the read-back order is whatever Postgres happens to return.
CREATE TABLE IF NOT EXISTS "redline_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"lens_id" text NOT NULL REFERENCES "redline_lenses" ("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"definition" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- `declaration_order` is stored because it is load-bearing: specificity first,
-- declaration order second, is the precedence between two matching rules
-- (ADR-0011).
CREATE TABLE IF NOT EXISTS "redline_hard_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"lens_id" text NOT NULL REFERENCES "redline_lenses" ("id") ON DELETE CASCADE,
	"pattern" text NOT NULL,
	"topic_id" text NOT NULL REFERENCES "redline_topics" ("id") ON DELETE CASCADE,
	"declaration_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- The binding is its own row, never a column on the lens (ADR-0009): a lens is
-- defined once and applied to any corpus.
CREATE TABLE IF NOT EXISTS "redline_lens_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"lens_id" text NOT NULL REFERENCES "redline_lenses" ("id") ON DELETE CASCADE,
	"evaluation_id" text NOT NULL REFERENCES "redline_evaluations" ("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One lens per evaluation: the classifier resolves exactly one lens per call,
-- so a second binding would make that resolution ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "redline_lens_bindings_evaluation_idx"
	ON "redline_lens_bindings" ("evaluation_id");

-- Both reads the lens reader performs are lens-scoped and ordered.
CREATE INDEX IF NOT EXISTS "redline_topics_lens_idx"
	ON "redline_topics" ("lens_id", "position");

CREATE INDEX IF NOT EXISTS "redline_hard_rules_lens_idx"
	ON "redline_hard_rules" ("lens_id", "declaration_order");
