# Thread 9 — `redline_` persistence layer

**Status:** ✅ Complete · **Date:** 2026-07-30 · **Version intent:** MINOR (pre-1.0; new persistence surface + own Postgres)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 3](../procurement-evaluation-plan.md)
· depends on [Thread 2](./thread-02-redline-domain-entities-and-ports.md) + [Thread 2a](./thread-02a-generalise-requirements.md)
· honours [ADR-0002](../adr/0002-own-minio-and-postgres.adr.md)

## Goal

Drizzle schema + repositories for the evaluation aggregate (evaluations, vendors,
response groups, responses) in a **redline-owned** Postgres, with migrations.

**Exit test:** repositories round-trip; migration idempotent.

## What was built — `packages/redline-adapters/src/persistence/`

| File | Contents |
|---|---|
| `schema.ts` | The four `redline_`-prefixed Drizzle tables (`redline_evaluations`, `redline_vendors`, `redline_response_groups`, `redline_responses`), snake_case columns, `id` / `created_at` / `updated_at` on every table. Currency is `numeric(18,2)` (real money); id arrays (`member_vendor_ids`, `vendor_ids`, `document_ids`) are `text[]`. FKs cascade from the evaluation. Exports `$inferSelect` / `$inferInsert` row types. |
| `row-mapping.ts` | Pure domain ↔ row functions — the one place the storage shape meets the entities. The load-bearing conversion: Postgres `numeric` is a decimal **string** on the wire, so `estimateAud` is `toFixed(2)` on write and `Number(...)` on read. Nullable provenance (`page`, `chunkId`) preserved both ways. |
| `db.ts` | The DB seam. `createRedlinePostgres({databaseUrl})` builds the production postgres-js + drizzle handle; `RedlineDatabase`/`schema` exported. The repository depends only on the drizzle query builder, so any driver satisfies it. |
| `drizzle-evaluation-repository.ts` | `DrizzleEvaluationRepository implements IEvaluationRepository`. Every method returns a `Result` — driver exceptions are caught and mapped to `INFRA_FAILURE`, `NOT_FOUND` for a missing evaluation. Saves are **upserts** (`onConflictDoUpdate`) so a use-case can re-run a stage idempotently. A response has no domain id, so the repo mints a stable `{group}:{requirement}:{doc}` key. |
| `migrations/0000_redline_initial.sql` | The initial DDL, hand-authored to mirror `schema.ts` (no local Node when the thread landed — regenerable via `db:generate`). Uses `IF NOT EXISTS` + `duplicate_object` guards so **re-running is a no-op** (the idempotency half of the exit test). |
| `apply-migrations.ts` | Driver-agnostic `applyMigrations(execute)` — applies the ordered SQL files. Shared by the migrate CLI and the tests. |
| `migrate.ts` | `pnpm --filter @redline/redline-adapters db:migrate` — applies migrations against `DATABASE_URL` (ADR-0002). |

Also: `drizzle.config.ts` (for `db:generate`); `drizzle-orm` + `postgres` added as
deps, `drizzle-kit` + `@electric-sql/pglite` + `tsx` as dev deps; exports wired
through the adapters index; a `redline` profile (`redline-postgres` on host `:5433`)
added to `infra/docker-compose.yml`.

## Design decisions

- **PGlite for the exit test.** No local Node and no live Postgres in this
  environment, but "repositories round-trip" demands a *real* Postgres, not a
  mock. [PGlite](https://pglite.dev) (Postgres compiled to WASM) runs in-process
  under vitest via `drizzle-orm/pglite`, so the round-trip + idempotency tests
  execute against genuine Postgres semantics (arrays, `numeric` decimal strings,
  FKs) with **zero external services** — the same posture Threads 5–7 used for
  their standalone proofs.
- **The same migration SQL builds the test schema and ships to production.** The
  round-trip test calls `applyMigrations` against PGlite; `migrate.ts` calls it
  against `DATABASE_URL`. One source of truth, and the idempotency test literally
  re-runs it.
- **Repository depends on the query builder, not a driver.** The injected handle
  is typed structurally, so postgres-js (prod) and PGlite (test) both satisfy it
  without a driver import leaking into the repository.
- **Upsert-on-save.** Orchestration (Thread 10) re-runs stages; `onConflictDoUpdate`
  keyed on the primary key makes every save idempotent, matching the domain's
  "advance a stage / re-classify a group" flows.
- **Currency stays numeric end-to-end.** `numeric(18,2)` in the DB, decimal-string
  on the drizzle wire, `number | null` in the domain — the review grid (Thread 12)
  and pivots (Thread 13) get real numbers, consistent with the Thread 8 adapter.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman):

```
redline-adapters test → Test Files 5 passed (5) · Tests 41 passed (41)
  src/persistence/row-mapping.test.ts                 (7)   ← Thread 9 (pure map)
  src/persistence/drizzle-evaluation-repository.test.ts (8) ← Thread 9 (round-trip + idempotency)
  src/womblex/womblex-extraction-reader.test.ts       (8)
  src/numbatch/numbatch-classifier.test.ts            (9)
  src/numbatch/numbatch-financial-extractor.test.ts   (9)

./validate.sh → Passed: 11  Failed: 0  — All validations passed. (incl. #7 redline_ prefix)
```

The repository suite (against PGlite): save/read an evaluation, upsert-on-re-save,
`NOT_FOUND` for a missing id, vendor consortium members round-trip, response-group
id arrays round-trip, **currency read back as a real number** (`1500.5`) with a
null-estimate fallback, and per-evaluation scoping. The final test **re-applies the
migration** and confirms the schema still works — the idempotency exit criterion.

## Known limitations / follow-ups

1. **No live Postgres `db:migrate` run in this environment** (no local Node/DB).
   The migration is proven idempotent against PGlite (real Postgres semantics) and
   the `redline` compose profile + `migrate.ts` are wired for a real run when Node
   is present. A `podman compose --profile redline up` + `db:migrate` smoke lands
   with the app wiring (Thread 10/11) or Thread 16.
2. **`0000_redline_initial.sql` is hand-authored** (mirrors `schema.ts`) because
   `drizzle-kit generate` needs local Node. `drizzle.config.ts` is in place; the
   next schema change should regenerate via `db:generate` and drop the hand guard
   comments.
3. Wiring the repository into use-cases (`saveResponses` after classify/extract,
   stage transitions) is Thread 10 (`redline-application`).
