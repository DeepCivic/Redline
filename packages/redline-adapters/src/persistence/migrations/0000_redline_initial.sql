-- redline_ schema — initial tables (Thread 9, ADR-0002).
-- Hand-authored to mirror src/persistence/schema.ts; kept idempotent with
-- IF NOT EXISTS so re-running the migration is a no-op (exit test: idempotent).
-- Regenerate with `pnpm --filter @redline/redline-adapters db:generate` once the
-- workspace has local Node; this file is the checked-in source of truth meanwhile.

CREATE TABLE IF NOT EXISTS "redline_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"stage" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "redline_vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"display_name" text NOT NULL,
	"is_consortium" boolean DEFAULT false NOT NULL,
	"member_vendor_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "redline_response_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"label" text NOT NULL,
	"vendor_ids" text[] DEFAULT '{}' NOT NULL,
	"document_ids" text[] DEFAULT '{}' NOT NULL,
	"is_consortium_response" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "redline_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"response_group_id" text NOT NULL,
	"vendor_name" text NOT NULL,
	"product_name" text NOT NULL,
	"requirement_id" text NOT NULL,
	"confidence" double precision NOT NULL,
	"product_summary" text NOT NULL,
	"estimate_aud" numeric(18, 2),
	"cost_description" text DEFAULT '' NOT NULL,
	"source_document_id" text NOT NULL,
	"source_element_order" integer NOT NULL,
	"source_page" integer,
	"source_chunk_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "redline_vendors" ADD CONSTRAINT "redline_vendors_evaluation_id_fk"
		FOREIGN KEY ("evaluation_id") REFERENCES "redline_evaluations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "redline_response_groups" ADD CONSTRAINT "redline_response_groups_evaluation_id_fk"
		FOREIGN KEY ("evaluation_id") REFERENCES "redline_evaluations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "redline_responses" ADD CONSTRAINT "redline_responses_evaluation_id_fk"
		FOREIGN KEY ("evaluation_id") REFERENCES "redline_evaluations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
