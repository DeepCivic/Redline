# ADR-0005 — Numbatch is a vendored fork; run all-but-frontend, bootstrap via API

- **Status**: Accepted
- **Date**: 2026-07-26

## Context

redline classifies procurement responses against **user-defined criteria**
([ADR-0004](./0004-user-defined-requirements-not-fixed-1-6.adr.md)). Numbatch
(DeepCivic/Numbatch) is exactly that engine: a no-code multi-topic classifier where a
**topic** = name + description + curated samples → a trained LoRA adapter, a **profile**
bundles ≤10 topics, and batch inference rolls per-chunk predictions up into per-document
classifications keyed on `source_doc_id` (Womblex's `source_hash`). Its architecture
(verified from `docs/ARCHITECTURE.md` / `docs/DATA_MODEL.md`) is: FastAPI **backend API**,
an **Arq worker**, a **DB-free inference service**, a **SvelteKit frontend**, over
Postgres + Redis + MinIO.

Build-plan decision #3 was already locked to *fork, run all-but-frontend*. Thread 5
implements it and needs the concrete mechanics recorded: what we vendor, what we run,
and how a redline evaluation becomes a trained Numbatch profile.

Two hard constraints shaped this:

1. **redline owns its own control surface and review grid** (Threads 11–12), so
   Numbatch's SvelteKit frontend is redundant and must not be part of redline's runtime.
2. The financial extension (Threads 6–7) modifies Numbatch's **backend** (new tables +
   an Arq worker stage), which requires a fork, not a pinned upstream image.

## Decision

**Vendor the Numbatch fork into `services/numbatch/` and run its backend + Arq worker +
inference service (plus Postgres + Redis + MinIO). Never run its SvelteKit frontend.
redline drives Numbatch entirely over its HTTP API.**

- **Vendoring.** `services/numbatch/` is the DeepCivic/Numbatch fork. It is *not*
  committed into this repo during the build phase (the tree is large and lives in its own
  remote); it is added as a submodule / sibling checkout the same way `vendor/wayfinder`
  is, and its Dockerfiles under `infra/docker/` are referenced by redline's compose
  `numbatch` profile. Thread 16 finalises how the fork ships. This mirrors ADR-0001's
  "compose over runtime seams, design as if C".
- **Run all-but-frontend.** The `numbatch` compose profile brings up
  `numbatch-postgres`, `numbatch-redis`, `numbatch-migrate` (one-shot `alembic upgrade
  head`), `numbatch-backend` (:8080), `numbatch-worker` (Arq), and `numbatch-inference`
  (:8100), reusing redline's own `minio` (ADR-0002). The frontend service is omitted.
- **Numbatch reads redline's chunks.** Numbatch's ingestion feed
  (`S3_WOMBLEX_BUCKET`) points at redline's bucket, so it ingests the same
  `proc/{evaluationId}/*.chunks.parquet` the womblex sidecar wrote — no extra copy.
- **Bootstrap via API, idempotent.** A redline `RequirementSet` becomes a Numbatch
  profile through the backend API, not a database seed:
  1. `POST /topics` per requirement (`name` = requirement name, `description` =
     definition); record the returned `topic_id` against the `requirementId`.
  2. `POST /topics/{id}/samples` with the curated example passages (the semantic signal
     Numbatch trains on).
  3. `POST /profiles` with the ordered `topic_id`s (≤10) → the profile.
  4. `POST /profiles/{id}/train`; poll `GET /training-jobs/{id}` to success.
  Re-running is safe: Numbatch's sample inserts dedupe on provenance/text
  (`uq_topic_samples_*`), and topic/profile names are unique per org among live rows.
  The `requirementId → topic_id` map produced here is the **`NumbatchProfileBinding`**
  the `NumbatchClassifier` adapter is constructed with.
- **`topic_id ↔ requirementId` translation lives only in the adapter.** The
  `NumbatchClassifier` (`redline-adapters`) is the single place the two vocabularies meet
  — it triggers a batch run, polls to success, reads the document roll-up, and maps each
  `topic_id` back to a `requirementId` via the binding.

## Consequences

**Positive**

- redline gets a real, user-defined semantic classifier without reimplementing training
  or inference, and keeps its own UI.
- The fork gives Threads 6–7 a place to add the financial extension in the backend.
- Bootstrapping over the public API (not DB seeds) keeps redline coupled only to
  Numbatch's HTTP seam, so a shared/managed Numbatch could later replace the vendored
  stack by config.

**Negative**

- redline now depends on a second forked service with a GPU-capable footprint
  (inference); local dev runs it CPU-only (`DEVICE=auto`, tiny base model in CI).
- Keeping the fork current with upstream is ongoing maintenance (mitigated: the financial
  extension is additive — new tables + a new worker stage).
- Training requires ≥10 curated samples per topic (Numbatch's fail-fast rule), so the
  bootstrap needs real example passages, not just a prose definition.

## Alternatives considered

- **Run the whole Numbatch stack including its frontend.** Rejected: redline owns the
  specialist control surface and review grid; two UIs is confusing and duplicative.
- **Pin an upstream Numbatch image, no fork.** Rejected: the financial extension
  (Threads 6–7) changes the backend schema and adds a worker stage — impossible without a
  fork.
- **Seed Numbatch's Postgres directly for bootstrap.** Rejected: couples redline to
  Numbatch's internal schema instead of its API, breaking ADR-0001's "design as if C".

## Enforcement

- Build-plan §8 decision #3 row references this ADR; §10 Thread 5 row links here.
- The `numbatch` compose profile in `infra/docker-compose.yml` has no frontend service.
- `NumbatchClassifier`'s contract test pins the `topic_id → requirementId` mapping
  against a captured Numbatch payload (`redline-adapters/src/numbatch/__fixtures__`).
