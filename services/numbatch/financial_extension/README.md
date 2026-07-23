# numbatch-financial — the financial extension (Thread 6)

redline's **additive** extension to the forked Numbatch backend
([ADR-0005](../../../docs/adr/0005-numbatch-fork-all-but-frontend.adr.md): the
financial extension is additive — new tables + a new Arq worker stage). This
directory holds the extension as a self-contained overlay so it is buildable and
testable **without vendoring the GPU-bearing fork on disk** (like Thread 5's
captured-payload contract test).

- **Thread 6 (this):** the `financial_profiles` + `financial_extractions` schema,
  one Alembic migration, and the financial-profile **config API**. Schema only.
- **Thread 7:** the Arq worker stage that *writes* `financial_extractions`.
- **Thread 8:** the redline-side `IFinancialExtractor` adapter that reads them.

## What the extension adds

Two tables (build plan §6), keyed so a figure attaches to a **(document,
requirement)** pair with no duplication:

| Table | Purpose | Key |
|---|---|---|
| `financial_profiles` | Per Numbatch **topic** (= a redline requirement, [ADR-0004](../../../docs/adr/0004-user-defined-requirements-not-fixed-1-6.adr.md)), config for *what* monetary facts to pull (`target_currency`, `cost_basis` one-off/recurring, `granularity` line-item/bundle) and *how* to normalise. | one live profile per `topic_id` |
| `financial_extractions` | The Thread 7 worker's output: one figure (or description fallback) per document, with provenance to womblex's `elem_order`. | **`uq_financial_extractions_doc_topic (source_doc_id, topic_id)`** — the no-duplication invariant |

`source_doc_id` is womblex's `source_hash`; `topic_id` is the Numbatch topic the
batch-inference roll-up matched. Because Numbatch already guarantees a chunk feeds
a topic at most once, the figure is extracted once per (document, requirement) —
no re-extraction per requirement (build plan §6).

## Config API (schema only)

Mounted onto the fork's FastAPI app (`app.include_router(build_router(...))`);
`build_app` stands it up standalone for tests.

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/financial-profiles` | Create one profile for a topic. **Idempotent by `topic_id`** — re-creating returns the existing profile (`200`), never a duplicate (matches the bootstrap's "safe to re-run", ADR-0005). New profile → `201`. |
| `GET` | `/financial-profiles` | List all profiles. |
| `GET` | `/financial-profiles/{id}` | Read one; `404` `NOT_FOUND` when absent. |

Errors are Result-shaped (`{"error": {"code", "message"}}`) to mirror the womblex
sidecar and map cleanly into the Thread 8 adapter's `DomainError`.

## Wiring into the fork (Thread 16)

The overlay is written to graft onto Numbatch unchanged:

1. Copy `src/numbatch_financial/` under the fork's `app/` and bind the models to
   Numbatch's own `Base`/`metadata` (drop the local `Base` in `models.py`).
2. `app.include_router(build_router(get_session))` on the backend app; reuse
   Numbatch's async session dependency.
3. Repoint the migration's `down_revision` (currently `None` for standalone
   testing) at Numbatch's current Alembic head, and place it in the fork's
   `alembic/versions/`. `alembic upgrade head` then applies it after the base
   schema — the compose `numbatch-migrate` one-shot already runs `alembic upgrade
   head`.

Until the fork is vendored (Thread 16), this overlay is the source of truth for
the extension and is validated by its own pytest suite.

## Test / validate

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest -q
```

- `test_config_api.py` — the config API incl. **the exit test** (create a
  financial profile for a topic → `201` with the profile body) + idempotency,
  list/read, and validation (`422`) / `404` paths.
- `test_migration.py` — runs the Alembic revision's `upgrade()`/`downgrade()`
  through a real Alembic `Operations` context against SQLite: both tables
  created, the `(source_doc_id, topic_id)` uniqueness enforced, downgrade
  reverses. This is the "migration passes CI" half of the exit test.

`./validate.sh` runs this suite as check #11 when `python3` is present (SKIPs
cleanly otherwise).
