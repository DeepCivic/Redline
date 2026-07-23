# Thread 6 — Numbatch financial_profile schema & config API

**Status:** ✅ Complete · **Date:** 2026-07-27 · **Version intent:** MINOR (pre-1.0; additive backend extension + config API)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 2](../procurement-evaluation-plan.md)
· depends on [Thread 5](./thread-05-numbatch-integration.md)
· enacts [ADR-0004](../adr/0004-user-defined-requirements-not-fixed-1-6.adr.md) + [ADR-0005](../adr/0005-numbatch-fork-all-but-frontend.adr.md)

## Goal

Extend the forked Numbatch backend (additively — ADR-0005) with the **financial
extension's schema and config surface**: two new tables (`financial_profiles`,
`financial_extractions` keyed on `(source_doc_id, topic_id)`), one Alembic
migration, and the financial-profile **config API**. Schema only — the Arq worker
that writes extractions is Thread 7; the redline-side adapter is Thread 8.

**Exit test:** create a financial profile for a topic via API; migration passes CI.

## What was built

A self-contained overlay at `services/numbatch/financial_extension/`, written to
graft onto the fork's `app/` + `alembic/` layout unchanged, but buildable and
testable **without the GPU-bearing fork vendored on disk** (same posture as Thread
5's captured-payload contract test; ADR-0005 records the fork isn't committed in
the build phase).

| File | Contents |
|---|---|
| `src/numbatch_financial/models.py` | SQLAlchemy 2.0 async models. `FinancialProfile` (per topic: `target_currency`, `cost_basis` one-off/recurring, `granularity` line-item/bundle; unique per `topic_id`). `FinancialExtraction` (the Thread 7 worker's output: `amount`/`currency`/`description` fallback + `source_elem_order` provenance; **`uq_financial_extractions_doc_topic (source_doc_id, topic_id)`** — the no-duplication invariant). A local `Base` so it tests standalone; grafts onto Numbatch's `Base` when vendored. |
| `src/numbatch_financial/schemas.py` | Pydantic v2 DTOs (`FinancialProfileCreate` with ISO-4217 `^[A-Z]{3}$` validation; `FinancialProfileRead` from ORM attributes). |
| `src/numbatch_financial/repository.py` | `FinancialProfileRepository` — the one place the config API touches the ORM (`get_by_topic`, `get_by_id`, `list_all`, `create`). |
| `src/numbatch_financial/api.py` | The config router (`build_router`) + a standalone `build_app`. `POST /financial-profiles` (idempotent by `topic_id`: existing → `200`, new → `201`), `GET /financial-profiles`, `GET /financial-profiles/{id}` (`404` `NOT_FOUND`). Result-shaped errors, mirroring the womblex sidecar. |
| `migrations/redline_financial_0001_financial_tables.py` | The additive Alembic revision creating both tables + indexes + unique constraints, with a `downgrade`. `down_revision = None` for standalone testing; repointed at Numbatch's head when vendored (Thread 16). |
| `tests/test_config_api.py` | 8 tests: the exit test (create → `201` with the profile body), defaults, idempotency-per-topic, list, read-by-id, `404`, and `422` validation (blank topic, malformed currency). |
| `tests/test_migration.py` | 3 tests running the migration's `upgrade()`/`downgrade()` through a real Alembic `Operations` context against SQLite: both tables created, `(source_doc_id, topic_id)` uniqueness enforced, downgrade reverses. The "migration passes CI" half. |
| `pyproject.toml` | Mirrors the fork's stack (FastAPI + SQLAlchemy async + Alembic + Pydantic v2); `dev` extra pins pytest/httpx/aiosqlite. |
| `README.md` | The extension, the config API, and how it grafts onto the fork (Thread 16). |

## Design decisions

- **Overlay, not a fork edit.** The fork isn't vendored on disk in this environment
  (ADR-0005; no GPU, large tree). Rather than block on Thread 16, the extension is a
  self-contained package written to drop into the fork unchanged — models bind to a
  local `Base` that swaps for Numbatch's, and the router mounts via
  `app.include_router`. Proven by its own pytest suite; a compose-up integration run
  lands with the vendored fork (Thread 16). Mirrors Thread 5's captured-payload posture.
- **`financial_extractions` declared in Thread 6, written in Thread 7.** The migration
  creates *both* tables in one additive step (a single `alembic upgrade head`); Thread 7
  only adds the worker that inserts rows. This avoids a second migration and keeps the
  schema change atomic.
- **Idempotent by `topic_id`.** One live financial profile per topic (= per requirement,
  ADR-0004). Re-`POST` returns the existing profile (`200`) rather than a duplicate —
  the same "safe to re-run" contract as the profile bootstrap (ADR-0005), so redline's
  orchestration (Thread 10) can configure financials without pre-checking.
- **`(source_doc_id, topic_id)` uniqueness in the schema, not just convention.** The
  no-duplication invariant (build plan §6) is enforced by
  `uq_financial_extractions_doc_topic`, and the migration test proves the constraint
  bites — a second insert for the same pair raises `IntegrityError`.
- **Result-shaped HTTP errors** (`{"error": {"code", "message"}}`) match the womblex
  sidecar so the Thread 8 `IFinancialExtractor` adapter maps them to `DomainError` the
  same way the Thread 4 reader does.

## Exit-test evidence

Run via `./validate.sh` (new check #11) and directly:

```
services/numbatch/financial_extension pytest → 11 passed
  tests/test_config_api.py   (8)  — incl. POST /financial-profiles → 201 {id, topic_id, …}
  tests/test_migration.py    (3)  — upgrade creates both tables; (source_doc_id, topic_id)
                                    uniqueness enforced; downgrade reverses

./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The config-API suite creates a financial profile for topic `topic-data-residency`
(`target_currency: "AUD"`, `cost_basis: "recurring"`, `granularity: "line_item"`) and
asserts a `201` with the persisted profile — **the exit test**. The migration suite
applies the Alembic revision through a real `Operations` context — **migration passes
CI**.

## Known limitations / follow-ups

1. **No live Numbatch compose-up in this environment** (no GPU; fork not vendored on
   disk — ADR-0005). The exit test runs the overlay against SQLite; a Postgres +
   `alembic upgrade head` integration run against the vendored fork lands in Thread 16.
   The migration is written for Postgres (native enum types); SQLite renders enums as
   VARCHAR, which is sufficient for the structural test here.
2. **`financial_extractions` has no write path yet** — that is Thread 7 (the Arq worker
   stage reading womblex table cells for a topic's matched, deduped chunks).
3. **Grafting into the fork** (bind to Numbatch's `Base`, repoint `down_revision`,
   `include_router`) is a Thread 16 mechanical step, documented in the overlay README.
