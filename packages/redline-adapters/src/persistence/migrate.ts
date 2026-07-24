// Migration entrypoint: `pnpm --filter @redline/redline-adapters db:migrate`.
// Applies the redline_ migrations against the Postgres named by DATABASE_URL
// (ADR-0002 — redline's own Postgres). Idempotent: safe to re-run.

import postgres from "postgres";
import { applyMigrations } from "./apply-migrations";

const main = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
    await applyMigrations((sql) => client.unsafe(sql));
    console.log("redline_ migrations applied");
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
