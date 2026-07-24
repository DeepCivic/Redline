import { defineConfig } from "drizzle-kit";

// Regenerates SQL from src/persistence/schema.ts into src/persistence/migrations/.
// The checked-in 0000_redline_initial.sql was hand-authored to mirror the schema
// (no local Node when Thread 9 landed); `pnpm --filter @redline/redline-adapters
// db:generate` takes over once the workspace has Node. Migrations run via the
// db:migrate script (src/persistence/migrate.ts) against DATABASE_URL (ADR-0002).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/persistence/schema.ts",
  out: "./src/persistence/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://redline:redline@localhost:5432/redline",
  },
});
