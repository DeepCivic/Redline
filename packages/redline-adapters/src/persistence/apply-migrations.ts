// Applies the redline_ migration SQL in order. Driver-agnostic: it takes an
// `execute(sql)` function, so the production `postgres` client and an in-process
// PGlite (tests) share one code path. The SQL files use IF NOT EXISTS / duplicate_object
// guards, so applying them twice is a no-op — the exit test's idempotency check.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Ordered migration files. Append new ones here as the schema evolves.
export const MIGRATION_FILES = [
  "0000_redline_initial.sql",
  "0001_redline_money_spans.sql",
  "0002_redline_chunks.sql",
  "0003_redline_lens.sql",
  "0004_redline_money_spans_full_span.sql",
  "0005_redline_graph.sql",
] as const;

export type SqlExecutor = (sql: string) => Promise<unknown>;

export const applyMigrations = async (execute: SqlExecutor): Promise<void> => {
  for (const file of MIGRATION_FILES) {
    const sql = await readFile(join(here, "migrations", file), "utf8");
    await execute(sql);
  }
};
