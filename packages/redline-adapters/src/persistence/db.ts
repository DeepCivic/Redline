// The redline_ database seam. redline owns its own Postgres (ADR-0002); the
// production driver is `postgres` (postgres-js), but the repository depends only
// on the drizzle instance *type*, so tests can inject an in-process PGlite drizzle
// (a real Postgres in WASM) with no external service.

import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export { schema };

// The drizzle instance shape the repositories accept — parameterised over the
// driver's query client so the postgres-js and PGlite drivers both satisfy it.
export type RedlineDatabase = {
  select: unknown;
  insert: unknown;
  update: unknown;
  delete: unknown;
} & Record<string, unknown>;

export interface RedlinePostgresOptions {
  // Full Postgres URL, e.g. postgres://redline:pw@redline-postgres:5432/redline.
  readonly databaseUrl: string;
  readonly max?: number;
}

// Production connection: postgres-js pool + drizzle bound to the redline_ schema.
// The caller owns the returned handle's lifecycle (call `.$client.end()` to close).
export const createRedlinePostgres = (options: RedlinePostgresOptions) => {
  const client = postgres(options.databaseUrl, { max: options.max ?? 10 });
  return drizzlePostgres(client, { schema });
};

export type RedlinePostgresDatabase = ReturnType<typeof createRedlinePostgres>;
