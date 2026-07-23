# Thread 5 — Numbatch integration (fork; run all-but-frontend)

**Status:** ✅ Complete · **Date:** 2026-07-26 · **Version intent:** MINOR (pre-1.0; new adapter surface + service scaffold + ADR-0005)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 2](../procurement-evaluation-plan.md)
· depends on [Thread 2a](./thread-02a-generalise-requirements.md) + [Thread 4](./thread-04-extraction-reader-adapter.md)
· enacts [ADR-0004](../adr/0004-user-defined-requirements-not-fixed-1-6.adr.md) + [ADR-0005](../adr/0005-numbatch-fork-all-but-frontend.adr.md)

## Goal

Wire redline to **Numbatch** (DeepCivic/Numbatch), the user-defined multi-topic
classifier. Vendor the fork, run it all-but-frontend, and implement a
`NumbatchClassifier` (`redline-adapters`) that maps a group's chunks →
per-document requirement classifications, translating Numbatch `topic_id` →
`requirementId`.

**Exit test:** ingested chunks → per-document requirement classifications
(user-defined topics), each with confidence + source chunk; contract test pins the
topic→requirement mapping against a **captured Numbatch payload**.

## Verified Numbatch API surface (not training data)

Read from the fork's own docs (`docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`):

- `POST /batch-inference/trigger` `{profile_id, strategy, source_doc_ids?}` → a
  `batch_inference_job` `{id, status, …}`; one active run per profile.
- `GET /batch-inference/jobs/{id}` → `{status: queued|running|succeeded|failed, error?}`.
- `GET /batch-inference/jobs/{id}/documents` → the roll-up: per `source_doc_id`,
  `{status: Classified|Unclassified, topics: [{topic_id, name, score, chunks_matched}, …]}`
  (score-sorted, ≤3 topics per document).
- Bootstrap: `POST /topics`, `POST /topics/{id}/samples`, `POST /profiles` (≤10 ordered
  topics), `POST /profiles/{id}/train`, `GET /training-jobs/{id}`.

## What was built

### Adapter — `packages/redline-adapters/src/numbatch/`

| File | Contents |
|---|---|
| `numbatch-classifier.ts` | `NumbatchClassifier implements IProcurementClassifier` over an injected method-aware `HttpClient` (POST body + GET; no global fetch). One `classifyResponseGroup`: trigger a run → poll to `succeeded`/`failed` (bounded by `maxPollAttempts`) → read the document roll-up → map each `topic_id` to a `requirementId` via the injected `NumbatchProfileBinding`. One `RequirementClassification` per (document, matched requirement). |
| `wire.ts` | The single place Numbatch's snake_case wire (`parseBatchJob`, `parseDocumentRollup`, `parseErrorBody`) is narrowed from `unknown`; nothing throws across the port edge. |
| `__fixtures__/batch-rollup.json` | A **captured Numbatch payload** — `.job` (trigger/status body) + `.documents` (per-document roll-up) — taken verbatim from Numbatch's documented shapes. |
| `numbatch-classifier.test.ts` | 9 contract tests: trigger/poll/roll-up happy path + the topic→requirement mapping, request-shape assertions, Unclassified & unmapped-topic drops, `failed`/timeout/transport/non-2xx error taxonomy. |

`NumbatchProfileBinding` (`profileId`, `strategy`, `topicToRequirement`) is the only
place `topic_id ↔ requirementId` is translated (ADR-0005). Exported from the adapters
index as `NumbatchClassifier` + its `Numbatch*` types (aliased to avoid clashing with the
womblex reader's `HttpClient`).

### Service — `services/numbatch/`

- `README.md` — the vendored fork (backend + worker + inference, **no frontend**), how to
  run the `numbatch` compose profile, and the idempotent bootstrap.
- `bootstrap-profile.py` — stdlib-only script turning a redline `RequirementSet` (+ curated
  samples per requirement) into a **trained Numbatch profile** over the API: `ensure_topic`
  → `add_samples` → `ensure_profile` → `train_and_wait`. Idempotent (reuses live
  topics/profiles by name; Numbatch dedupes samples). Prints the exact
  `NumbatchProfileBinding` the adapter consumes.
- `infra/docker-compose.yml` — new `numbatch` profile: `numbatch-postgres`,
  `numbatch-redis`, `numbatch-migrate` (one-shot `alembic upgrade head`), `numbatch-backend`
  (:8080), `numbatch-worker` (Arq), `numbatch-inference` (:8100), reusing redline's `minio`
  (its ingestion feed points at redline's `proc/` bucket). No frontend service.

### Decision

[ADR-0005](../adr/0005-numbatch-fork-all-but-frontend.adr.md) — vendor the fork; run
all-but-frontend; bootstrap via API; `topic_id ↔ requirementId` only in the adapter.
Locks build-plan §8 decision #3.

## Design decisions

- **Trigger → poll → roll-up in the adapter.** Numbatch's batch inference is async; the
  classifier owns the poll loop (bounded, injectable interval) so the port stays a simple
  `Promise<Result<…>>` and tests run with `pollIntervalMs: 0`.
- **`sourceChunkId: null` at the roll-up.** `document_classifications` is per-document, not
  per-chunk; the domain field is nullable, so the roll-up faithfully sets it null rather
  than inventing a chunk. Per-chunk provenance (`GET .../results`) is a later concern if a
  drill-down needs it.
- **Drop unmapped topics, don't invent.** A `topic_id` absent from the binding is skipped —
  the binding is the source of truth for which topics belong to this evaluation.
- **Method-aware `HttpClient`.** Unlike the womblex reader's GET-only seam, Numbatch needs a
  POST body, so this adapter's `HttpClient` takes an `HttpRequest {method, url, body?}`.
- **Vendored fork not committed in the build phase** (like `vendor/wayfinder`) — the tree is
  large and lives in its own remote; compose references its Dockerfiles. Thread 16 finalises
  shipping.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman):

```
redline-adapters test → Test Files 2 passed (2) · Tests 17 passed (17)
  src/womblex/womblex-extraction-reader.test.ts  (8)
  src/numbatch/numbatch-classifier.test.ts       (9)  ← Thread 5

./validate.sh → Passed: 10  Failed: 0  — All validations passed.
```

The `numbatch-classifier` suite reads the captured payload
(`__fixtures__/batch-rollup.json`) and asserts: two documents → 3
`RequirementClassification` rows, `topic_id "t-data-residency"` → `requirementId
"req-data-residency"` with `confidence ≈ 0.86`, and the full error taxonomy. `python3 -m
py_compile bootstrap-profile.py` passes.

## Known limitations / follow-ups

1. **No live Numbatch run in this environment** (no GPU; fork not yet vendored on disk).
   The exit test is a captured-payload contract test, per the plan's wording ("contract
   test pins the topic→requirement mapping against a captured Numbatch payload"). A
   compose-up integration run lands when the fork is checked out (or in Thread 16).
2. The `NumbatchProfileBinding` is produced by `bootstrap-profile.py` and injected by the
   caller; wiring it through a use-case + persistence is Threads 9–10.
3. Financial extension (Threads 6–7) adds `financial_profiles` / `financial_extractions`
   to the forked backend, consumed by the `IFinancialExtractor` adapter (Thread 8).
