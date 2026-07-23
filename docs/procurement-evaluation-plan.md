# Procurement Evaluation Adapter — Build Plan

> A Wayfinder plugin/adapter (its own repo) for procurement evaluation, integrating
> **womblex** (document extraction) and **Numbatch** (no-code classification of
> **user-defined requirements/criteria**, extended with financial figures mapped to
> those requirements).
>
> **Update (2026-07-26, [ADR-0004](./adr/0004-user-defined-requirements-not-fixed-1-6.adr.md)):**
> requirements are **user-defined criteria**, not a fixed 1–6 set. This is the whole
> reason for Numbatch. §1/§5/§6 and Threads 2a & 5–8 below reflect the correction.

_Repository:_ **`DeepCivic/Redline`**.

---

## 1. Goal

A tabular, sortable **in-app review flow** for procurement responses, with Excel export.

The evaluation is driven by a set of **user-defined requirements/criteria** — the user
names each criterion and defines it *semantically* (a prose definition plus curated
example passages that train a Numbatch topic classifier). An evaluation bundles up to
**10** requirements (Numbatch's per-profile cap; more than 10 degrades some base models
— [ADR-0004](./adr/0004-user-defined-requirements-not-fixed-1-6.adr.md)).

**Per response, capture:**
- vendor name
- product name
- **which requirement(s)/criteria the response matched** (user-defined; a document may
  match more than one, ≤3 per Numbatch roll-up), each with a confidence + source chunk
- one-paragraph product summary
- dot-point costing extract (dollar estimate if provided, else a short description of
  costs), **mapped to the matched requirement** with no duplication (reuses the
  roll-up's deduped per-chunk provenance)
- link to document location (page / chunk provenance)

**Aggregate:**
- pricing per brand (vendor)
- pricing per requirement/criterion

**Priorities:** in-app review first; Excel export second.

---

## 2. Upstream tools (corrected understanding)

| Tool | What it is | Consumption |
|---|---|---|
| **womblex** | Python document-extraction pipeline. Detects doc type, extracts, chunks, optionally enriches/classifies via Isaacus. Writes **Parquet shards to S3/MinIO** (`*.elements.parquet`, `*.table_cells.parquet`, `*.form_fields.parquet`, `*.chunks.parquet`, `*._manifest.parquet`). | Run as a sidecar/worker; consume Parquet output (or a JSON wrapper) from object storage. Has non-Isaacus modes (edge/offline). |
| **Numbatch** | Python no-code multi-topic classifier (FastAPI backend + Arq workers, a **DB-free inference service**, SvelteKit frontend). A **topic** = name + description + curated samples → a trained **LoRA adapter**; a **profile** bundles ≤10 topics; batch inference rolls per-chunk predictions up into per-document classifications with per-chunk provenance. Ingests womblex chunk Parquet natively. | Standalone stack (three services + Postgres/Redis/MinIO). **Forked**; we run **all services except the SvelteKit frontend** (redline owns its own control surface + review grid), and **extend the backend** for financial extraction. A redline **requirement/criterion** maps to a Numbatch **topic**; an evaluation's requirement set maps to a Numbatch **profile**. |

**Womblex provenance keys:** `source_hash` (document identity), `elem_order`, `page`/`bbox`,
`chunk_id = "{source_hash}:{chunk_index}"`, currency cells in `table_cells` / `sheet_cell` / `form_fields`.

---

## 3. Why a separate repo / adapter (not a Wayfinder fork)

- Wayfinder is a strict hexagonal TypeScript monorepo; heavy Python deps and foreign runtimes
  are forbidden in `packages/*`.
- Wayfinder already runs Python sidecars (`services/australian-writing-mcp`), uses **MinIO/S3**
  (`IObjectStorage`), and has a typed **tabular + XLSX export** engine we can reuse
  (`field-report-view.ts`, `field-report-pivot.ts`, `computePivot`, `typedDisplayCell`).
- So: compose over runtime seams (HTTP/MCP + object storage + a separate DB schema),
  reuse Wayfinder's typed helpers read-only, never reach into its internals.

### Consumption strategy (Wayfinder packages are `workspace:*`, not published to npm)

| Strategy | Mechanism | Trade-off |
|---|---|---|
| **A. Submodule / sibling checkout (recommended for build)** | Wayfinder as a submodule; extend pnpm workspace | Typed reuse + clean path to becoming its own workspace |
| B. Private registry | Wayfinder publishes `@rbrasier/*` | Needs Wayfinder release changes (out of scope) |
| C. Pure runtime integration | HTTP/MCP + shared MinIO + shared schema only | Most decoupled; loses typed reuse |

**Chosen approach:** Build with **A**, but design all runtime seams **as if C**, so the
plugin only depends on Wayfinder's ports — a true adapter, not a fork.

---

## 4. Target repo layout

```
redline/
├── services/
│   ├── womblex-ingest/          # womblex sidecar; Isaacus optional (flag)
│   └── numbatch/                # Numbatch fork: backend + inference (NOT frontend); + financial extension
├── packages/
│   ├── redline-domain/             # entities + ports (zero deps, Result pattern)
│   ├── redline-application/        # use-cases (imports redline-domain + @rbrasier/domain types)
│   ├── redline-adapters/           # Parquet/JSON reader, Numbatch client, repositories
│   └── redline-shared/             # zod schemas shared with the UI
├── apps/
│   └── redline-web/                # specialist control surface + review grid
└── infra/
    └── docker-compose.yml       # womblex + numbatch + postgres + minio (compose profiles)
```

- All new tables use a **`redline_` prefix** in a **separate Postgres schema/DB**.
- Result pattern at all boundaries; tests-first; mirror Wayfinder's code-writing rules.

---

## 5. Core data model

```typescript
// redline-domain/src/entities/requirement.ts
// A user-defined criterion. Maps to a Numbatch topic at the adapter boundary.
// The semantic definition is `definition` (prose) + curated samples in Numbatch.
export interface Requirement {
  id: string;
  name: string;
  definition: string;               // the semantic definition of the criterion
}

// An evaluation's ordered requirement set. Mirrors a Numbatch profile (≤10).
export interface RequirementSet {
  evaluationId: string;
  requirements: Requirement[];       // ordered; max 10 (ADR-0004)
}

// redline-domain/src/entities/procurement-response.ts
export interface ProcurementResponse {
  evaluationId: string;
  responseGroupId: string;
  vendorName: string;                        // "brand"
  productName: string;
  requirementId: string;                     // user-defined criterion (was: fixed 1–6)
  confidence: number;                        // roll-up confidence for this requirement
  productSummary: string;          // one paragraph, AI-generated over the vendor's chunks
  costing: {
    estimateAud: number | null;    // typed currency → real numeric Excel cell
    description: string;           // used when no figure was provided
  };
  source: {
    documentId: string;            // womblex source_hash
    elementOrder: number;          // womblex elem_order
    page: number | null;
    chunkId: string | null;        // "{source_hash}:{chunk_index}"
  };
}
```

> A document may match **more than one** requirement (Numbatch roll-ups are multi-label,
> ≤3 topics per document), so a response group yields **one `ProcurementResponse` row per
> (document, matched requirement)** — the review grid's natural unit.

### Workflow manager model (one response ≠ one document)

Relationships are many-to-many: 1 vendor→N docs→1 response; N vendors→1 response (consortium);
1 vendor→N responses (multiple offerings).

```typescript
// redline-domain/src/entities/evaluation-structure.ts
export interface Vendor {
  id: string;
  displayName: string;
  isConsortium: boolean;
  memberVendorIds: string[];        // populated when isConsortium
}

export interface ResponseGroup {
  id: string;
  evaluationId: string;
  vendorIds: string[];              // >1 ⇒ consortium response
  label: string;                    // e.g. "Acme — Core Platform Bid"
  documentIds: string[];            // womblex source_hash values, N per group
}

export type IntakeStage =
  | "documents_uploaded"   // womblex extraction done
  | "grouping"             // specialist assigns docs → response groups / vendors
  | "classifying"          // Numbatch: user-defined requirements + financials
  | "review"               // the tabular review grid
  | "finalised";
```

The control surface lets the specialist drag documents into response groups, mark consortiums,
split a vendor's multiple bids, and (re)run classification per group.

---

## 6. Numbatch extension — financial figures mapped to requirements (no duplication)

Numbatch today: chunk → topic classification → per-document roll-up (with per-chunk
provenance, and a chunk feeding two topics classified once). We add:

- **`financial_profile`** (new concept): per topic (= requirement/criterion), a config
  declaring what monetary facts to pull (unit price, total, recurring vs one-off,
  currency, line-item vs bundle) and how to normalise.
- **New Arq worker stage:** for each topic a document matched, reads womblex
  `table_cells` / `sheet_cell` / `form_fields` (currency-typed) **for that topic's
  already-deduped matched chunks**; extracts figures or a **description fallback**;
  writes `financial_extractions` keyed on **(`source_doc_id`, `topic_id`)** with
  provenance to `elem_order`.
- **No duplication:** the figure attaches to the (document, requirement) pair via the
  roll-up's matched-chunk provenance — Numbatch already guarantees a chunk feeds a topic
  at most once (`uq_topic_samples_provenance`), so no re-extraction per requirement
  ([ADR-0004](./adr/0004-user-defined-requirements-not-fixed-1-6.adr.md)).
- Directly serves the "dollar estimate **or** short description" requirement.

This is the largest net-new engineering item; it lives in the **forked Numbatch backend**.

---

## 7. Phased plan — one step = one AI thread

Each thread is independently buildable, testable, reviewable, with an explicit exit test.

> **Doc convention.** When a thread completes, append a link to its technical doc
> (or package README) to that thread's entry, in the form
> `— docs: [thread-NN](./threads/thread-NN-<slug>.md)`. The `/build` skill does this
> automatically. Thread docs live in [`docs/threads/`](./threads/).

### Track 0 — Foundations
- **Thread 1 — Repo scaffold & Wayfinder consumption spike.** pnpm monorepo (turbo, tsconfig,
  eslint mirroring Wayfinder). Wayfinder as submodule; prove one typed import compiles + runs.
  _Exit: `pnpm build` green; test importing `typedDisplayCell` passes._
  — docs: [thread-01](./threads/thread-01-scaffold-and-spike.md)
- **Thread 2 — `redline-domain` core entities & ports.** `Vendor`, `ResponseGroup`, `IntakeStage`,
  `ProcurementResponse`, `ProcurementRequirement` (fixed 1–6 + user-defined categories); ports:
  `IProcurementExtractionReader`, `IProcurementClassifier`, `IFinancialExtractor`, `IEvaluationRepository`.
  Zero deps, Result pattern, tests-first. _Exit: domain builds; entity invariants covered._
  — docs: [thread-02](./threads/thread-02-redline-domain-entities-and-ports.md)
- **Thread 2a — Generalise requirements: user-defined criteria (fix-forward).** Reverses the
  fixed 1–6 model per [ADR-0004](./adr/0004-user-defined-requirements-not-fixed-1-6.adr.md).
  Replace `procurement-requirement.ts`'s `REQUIREMENT_NUMBERS`/`RequirementNumber` with a
  user-defined `Requirement` (`id`, `name`, `definition`) + `RequirementSet` (ordered, ≤10);
  swap `requirementNumber` → `requirementId` in `ProcurementResponse`, `RequirementClassification`
  (add `confidence` already present), and `FinancialExtraction` (Threads 6–8). Update
  `procurement-classifier.ts`/`financial-extractor.ts` port DTOs. Zero deps, tests-first.
  _Exit: domain builds; `Requirement`/`RequirementSet` invariants covered (incl. the ≤10 cap);
  no `RequirementNumber` remains; `./validate.sh` green incl. purity check #4._
  — docs: [thread-02a](./threads/thread-02a-generalise-requirements.md)

### Track 1 — Ingestion (womblex)
- **Thread 3 — womblex sidecar service.** `services/womblex-ingest`: Dockerfile installing womblex
  (Isaacus behind opt-in build arg/flag); HTTP/MCP wrapper `ingest(documents) → run_id`,
  `status(run_id)`; writes Parquet to MinIO under `proc/{evaluationId}/`.
  _Exit: compose up, POST docs, shards land in MinIO._
  — docs: [thread-03](./threads/thread-03-womblex-sidecar-service.md)
- **Thread 4 — Extraction reader adapter (Parquet→JSON boundary).** Decide + implement boundary:
  sidecar emits **JSON** (recommended — keeps TS free of Parquet) or a Parquet-reading TS adapter.
  Implement `IProcurementExtractionReader` (elements/table-cells/chunks + provenance).
  _Exit: adapter reads a real run into typed objects; contract test against fixture._
  — docs: [thread-04](./threads/thread-04-extraction-reader-adapter.md)

### Track 2 — Classification & financials (Numbatch)
- **Thread 5 — Numbatch integration (fork; run all-but-frontend).** Vendor the Numbatch fork
  into `services/numbatch`; add a `numbatch` compose profile running **backend + Arq worker +
  inference service + Postgres + Redis + MinIO** (the SvelteKit frontend is excluded — redline
  owns its own control surface, Thread 11). Provide an idempotent bootstrap that creates an
  evaluation's **user-defined requirement topics** (name + definition + curated samples) and a
  **profile** (≤10), then trains it. Implement `NumbatchClassifier` (`redline-adapters`,
  HTTP/OpenAPI over an injected `HttpClient`) implementing `IProcurementClassifier`: trigger batch
  inference over a group's chunks, read per-document roll-ups, and **map Numbatch `topic_id` →
  `requirementId`** into `RequirementClassification[]` (one row per matched requirement). Requires
  Thread 2a. Locks decision #3 ([ADR-0004] scope + a fork ADR).
  _Exit: ingested chunks → per-document requirement classifications (user-defined topics), each
  with confidence + source chunk; contract test pins the topic→requirement mapping against a
  captured Numbatch payload._
  — docs: [thread-05](./threads/thread-05-numbatch-integration.md)
- **Thread 6 — Numbatch extension: `financial_profile` schema & config API.** New tables
  (`financial_profiles`, `financial_extractions` keyed on `(source_doc_id, topic_id)`), Alembic
  migration, config endpoints. Schema only.
  _Exit: create a financial profile for a topic via API; migration passes CI._
- **Thread 7 — Numbatch extension: financial extraction worker.** Arq stage reads womblex
  table cells for a topic's **matched, deduped** chunks; extracts currency-normalised figures or
  description fallback; writes `financial_extractions` with provenance — one figure per
  (document, requirement), no duplication.
  _Exit: synthetic tender workbook → figures + provenance in DB; unit + integration tests._
- **Thread 8 — `IFinancialExtractor` adapter.** `redline-adapters` client pulling `financial_extractions`
  (per document + `requirementId`) into `ProcurementResponse.costing` (`estimateAud: number | null`
  + `description`).
  _Exit: contract test; currency numeric via `typedDisplayCell`._

### Track 3 — Persistence & orchestration
- **Thread 9 — `redline_` persistence layer.** Drizzle schema + repositories (evaluations, vendors,
  response groups, responses); separate Postgres DB/schema; migrations.
  _Exit: repositories round-trip; migration idempotent._
- **Thread 10 — Orchestration use-cases (`redline-application`).** `IngestDocuments`,
  `AssignDocumentsToGroups`, `ClassifyResponseGroup`, `ExtractFinancials`, `BuildEvaluationTable`.
  One-paragraph AI summary via an `ILanguageModel`-shaped port.
  _Exit: use-case tests with mocked ports produce a full `ProcurementResponse[]`._

### Track 4 — Control surface & review (apps/redline-web)
- **Thread 11 — Workflow manager UI (specialist control surface).** Drag docs → response groups;
  mark consortium; split multi-bid vendors; drive `IntakeStage`; trigger (re)classification per group.
  _Exit: specialist can compose the three relationship shapes and advance stages._
- **Thread 12 — In-app review grid (priority 1).** Sortable/filterable table reusing
  `field-report-view` typed cells; source column deep-links to document location; all required columns.
  _Exit: real evaluation renders; currency sorts numerically; source links resolve._
- **Thread 13 — Pricing pivots.** Reuse `computePivot` for per-brand and per-requirement/criterion
  rollups (sum/avg of `estimateAud`); axis selection (brand, requirement, brand×requirement).
  _Exit: pivot matches hand-computed totals on a fixture._
- **Thread 14 — Excel export (priority 2).** "Export to Excel" reusing Wayfinder's XLSX path so
  currency stays numeric; one sheet for the table, one per pivot.
  _Exit: workbook opens with numeric currency + working document links._

### Track 5 — Hardening & handover
- **Thread 15 — Isaacus-optional & air-gap validation.** Prove womblex non-Isaacus path end-to-end;
  document both modes; surface as a UI config toggle. _Exit: full pipeline runs with `ISAACUS_API_KEY` unset._
- **Thread 16 — Workspace extraction & release prep.** Split into standalone workspace; sever the
  submodule dependency to the minimum seam (vendor/publish typed helpers or reimplement); CI,
  compose docs, README. _Exit: builds and runs standalone; validate script green._

---

## 8. Cross-cutting decisions to lock before Thread 1

1. **Consumption strategy** — **LOCKED: A** (submodule + typed reuse), designed as if C.
   Recorded in [ADR-0001](./adr/0001-adapter-over-wayfinder.adr.md). Wayfinder resolves via
   `pnpm-workspace.yaml` entry `vendor/wayfinder/packages/*`.
2. **Parquet boundary (Thread 4)** — **LOCKED: JSON** — the `womblex-ingest` sidecar reads its own Parquet shards and serves a typed JSON read model (`GET /extractions/{evaluationId}/{documentId}`); the TypeScript adapter never links a Parquet reader. Recorded in [ADR-0003](./adr/0003-parquet-to-json-boundary.adr.md).
3. **Numbatch coupling** — **LOCKED: fork, run all-but-frontend** — vendor the Numbatch fork into
   `services/numbatch` and run its backend + Arq worker + inference service (SvelteKit frontend
   excluded; redline owns its own UI). The fork is required for the financial extension (Threads
   6–7). A redline **requirement/criterion** ⇔ Numbatch **topic**; an evaluation's requirement set
   ⇔ a Numbatch **profile** (≤10). Requirements are **user-defined**, not fixed 1–6
   ([ADR-0004](./adr/0004-user-defined-requirements-not-fixed-1-6.adr.md)). The fork mechanics
   — vendor, run all-but-frontend, bootstrap via API, `topic_id ⇔ requirementId` only in the
   adapter — are recorded in [ADR-0005](./adr/0005-numbatch-fork-all-but-frontend.adr.md).
4. **Shared vs separate MinIO/Postgres** — **LOCKED: own** — redline stands up its own MinIO (bucket `redline`, shards under `proc/{evaluationId}/`) and its own Postgres (`redline_` prefix); the seam stays plain S3/Postgres so a deployment can still collapse to a shared instance by config. Recorded in [ADR-0002](./adr/0002-own-minio-and-postgres.adr.md).
5. **Auth/roles** — _open_ — does the review surface reuse Wayfinder auth/roles, or its own? Decide before Thread 11.

> **ADR model adopted.** This repo now follows Wayfinder's ADR format under
> [`docs/adr/`](./adr/README.md). Decision 5 will get its own ADR when locked.

---

## 9. Reused Wayfinder building blocks (read-only)

- `packages/domain/src/entities/field-report-view.ts` — `typedDisplayCell`, `typedCellValue`, `coalesceValue`
- `packages/domain/src/entities/field-report-pivot.ts` — `computePivot` (per-brand / per-category rollups)
- `packages/domain/src/ports/object-storage.ts` — `IObjectStorage` shape (MinIO/S3)
- XLSX generation path (`XlsxGenerator`, `document-generator-router.ts`) — numeric currency cells
- Sidecar precedent: `services/australian-writing-mcp` (Python-over-MCP)

---

## 10. Build state / progress log

_This section is the living "current state" tracker. Update it at the end of every thread._

| Thread | Status | Notes |
|---|---|---|
| 1 — Repo scaffold & Wayfinder consumption spike | ✅ **done** | Exit test **passing**: `pnpm build` green (4/4), spike importing `typedDisplayCell` from `@rbrasier/domain` passes (3/3), `./validate.sh` 9/9. Verified in a Node 20 container via Podman. Docs: [thread-01](./threads/thread-01-scaffold-and-spike.md). Also adopted: `.claude/` skills + `CLAUDE.md`, Podman-aware `validate.sh`, `docs/guides/local-dev-and-validation.md`. |
| 2 — redline-domain core entities & ports | ✅ **done** | Exit test **passing**: `redline-domain` builds; 36 new invariant tests (entities + port conformance) green, Thread 1 spike still 3/3 → 39/39; `./validate.sh` 9/9 incl. purity check #4. Entities: `Evaluation`, `Vendor`, `ResponseGroup`, `IntakeStage`, `ProcurementRequirement`, `ProcurementResponse` (smart constructors). Ports: `IProcurementExtractionReader`, `IProcurementClassifier`, `IFinancialExtractor`, `IEvaluationRepository`. Docs: [thread-02](./threads/thread-02-redline-domain-entities-and-ports.md). |
| 3 — womblex sidecar service | ✅ **done** | Exit test **PASSED** against real MinIO via `podman compose` (`ingest` profile): `POST /ingest` → `202 succeeded`, three shards land under `proc/{eval}/` (`_manifest` + per-doc `*.elements.parquet`), `GET /status` reports succeeded, unknown run → 404. `services/womblex-ingest` = FastAPI sidecar (`/health`, `POST /ingest`, `GET /status/{run_id}`), boto3 S3 writer, deterministic stub extractor default (`WOMBLEX_MODE=stub`; real womblex + Isaacus opt-in build args, finalised Thread 4). 12 pytest + `./validate.sh` **10/10** (new check #10). Decision #4 **LOCKED** ([ADR-0002](./adr/0002-own-minio-and-postgres.adr.md): own MinIO/Postgres). Docs: [thread-03](./threads/thread-03-womblex-sidecar-service.md). |
| 4 — Extraction reader adapter | ✅ **done** | Exit test **PASSED**: `WomblexExtractionReader` (`redline-adapters`) reads a real sidecar run into typed `ExtractionElement`/`ExtractionChunk`/`ExtractionTableCell` provenance; 8 contract tests against a captured fixture (`__fixtures__/extraction-tender.pdf.json`) cover the happy path + error taxonomy (NOT_FOUND / INFRA_FAILURE / EXTRACTION_FAILED). Decision #2 **LOCKED: JSON** ([ADR-0003](./adr/0003-parquet-to-json-boundary.adr.md)) — sidecar reads its own Parquet and serves JSON at `GET /extractions/{eval}/{doc}` (stored beside the shards for restart durability); TS never links a Parquet reader. Sidecar grew a JSON read model (`records.py`) + read endpoint; pytest **17/17** (was 12), workspace **7/7**, `./validate.sh` **10/10**. Docs: [thread-04](./threads/thread-04-extraction-reader-adapter.md). |
| 2a — Generalise requirements (user-defined criteria) | ✅ **done** | Exit test **PASSED**: dropped fixed 1–6; new `Requirement` (`id`/`name`/`definition`) + `RequirementSet` (ordered, unique, ≤10 = `MAX_REQUIREMENTS_PER_SET`); `requirementNumber` → `requirementId` + added `confidence` in `ProcurementResponse`; `requirementId` in `RequirementClassification` (dropped `categorisation`) and `FinancialExtraction`. `procurement-requirement.ts` deleted; no `RequirementNumber` remains. `redline-domain` **42/42** (6 files), `./validate.sh` **10/10** incl. purity check #4. Enacts [ADR-0004](./adr/0004-user-defined-requirements-not-fixed-1-6.adr.md). Docs: [thread-02a](./threads/thread-02a-generalise-requirements.md). |
| 5 — Numbatch integration (fork; run all-but-frontend) | ✅ **done** | Exit test **PASSED**: `NumbatchClassifier` (`redline-adapters`) triggers a batch run → polls to success → reads the per-document roll-up → maps Numbatch `topic_id` → `requirementId` into `RequirementClassification[]`; 9 contract tests against a **captured Numbatch payload** (`__fixtures__/batch-rollup.json`) pin the mapping + full error taxonomy (adapters **17/17**). Service scaffold: `services/numbatch/` (README + idempotent `bootstrap-profile.py`) + `numbatch` compose profile (postgres/redis/minio/backend/worker/inference, **no frontend**). Decision #3 **LOCKED** ([ADR-0005](./adr/0005-numbatch-fork-all-but-frontend.adr.md)). `./validate.sh` **10/10**. Docs: [thread-05](./threads/thread-05-numbatch-integration.md). |
| 6 — Numbatch financial_profile schema & API | 🔵 **next** | Tables keyed on `(source_doc_id, topic_id)`. Extends the forked Numbatch backend. |
| 7 — Numbatch financial extraction worker | ⚪ not started | One figure per (document, requirement); reuses roll-up dedupe. |
| 8 — IFinancialExtractor adapter | ⚪ not started | |
| 9 — redline_ persistence layer | ⚪ not started | |
| 10 — Orchestration use-cases | ⚪ not started | |
| 11 — Workflow manager UI | ⚪ not started | |
| 12 — In-app review grid | ⚪ not started | |
| 13 — Pricing pivots | ⚪ not started | |
| 14 — Excel export | ⚪ not started | |
| 15 — Isaacus-optional & air-gap validation | ⚪ not started | |
| 16 — Workspace extraction & release prep | ⚪ not started | |

### Thread 1 log (2026-07-23) — ✅ COMPLETE

**Recovered plan.** This plan was authored in a prior session in *plan (read-only) mode*
and never written to disk. Recovered verbatim from the Continue session history
(`~/.continue/sessions/ac21e544-…json`, idx 48) and persisted here.

**Scaffolded** (`redline/`):
- Root: `package.json` (turbo scripts scoped `--filter=@redline/*`), `pnpm-workspace.yaml`
  (incl. `vendor/wayfinder/packages/*`), `turbo.json`, `tsconfig.base.json`, `tsconfig.json`,
  `.prettierrc`, `eslint.config.mjs` (domain = relative-imports-only; `vendor/**` ignored),
  `.gitignore`, `.gitmodules`, `README.md`.
- `packages/redline-domain/` — zero-dep `Result`/`DomainError` primitives, `index.ts`, and the
  **consumption spike test** `src/wayfinder-spike.test.ts` importing `typedDisplayCell` /
  `typedCellValue` from `@rbrasier/domain`.
- `packages/redline-shared`, `packages/redline-application`, `packages/redline-adapters` — package.json
  (`test` = `vitest run --passWithNoTests`) + tsconfig + placeholder `index.ts`.
- `apps/README.md`, `services/README.md` — placeholders for later threads.
- `docs/adr/README.md` + `docs/adr/0001-adapter-over-wayfinder.adr.md` — **Wayfinder ADR model adopted.**
- `scripts/podman-run.sh` — reproducible Node-20-in-Podman harness (host had no local node).

**Exit test — PASSED.** Run in `docker.io/library/node:20-bookworm-slim` via Podman
(`flatpak-spawn --host`), pnpm 9.12.0:
- `pnpm install` → clean (168 pkgs; `@rbrasier/domain` resolved as a workspace dep).
- `pnpm build` → **4 successful / 4 total**.
- `pnpm test` → **7 successful / 7 total**; `redline-domain` spike **3/3 passed**
  (`typedDisplayCell("currency", "1200.50")` → `{ value: 1200.5, isNumeric: true }`).
- `pnpm typecheck` → **7 successful / 7 total**.

**Delineation approach (decision #2 of this session).** Instead of an on-disk submodule/symlink,
Wayfinder's **source is vendored into a throwaway scratch copy** at `vendor/wayfinder` *only inside
the container* by `scripts/podman-run.sh` — currently just `packages/domain` (zero-dep). The
committed `redline` tree never contains Wayfinder, and the real Wayfinder tree is never
written to. This keeps a hard boundary while `@rbrasier/*` still resolves as workspace packages.
`WAYFINDER_PACKAGES` env var widens the vendored set when later threads need `shared`/`adapters`.

**Publishing target (decision #3 of this session).** Remote will be the **DeepCivic** org
(not johntooth). `.gitmodules` url points at DeepCivic; set the actual git remote at `git init` time.

**Remaining setup (not blocking Thread 1's exit test, needed for real git workflow):**
1. `git init` `redline` and add the DeepCivic remote.
2. Wire `vendor/wayfinder` for local (non-Podman) dev — submodule against the DeepCivic Wayfinder
   mirror, or a symlink to a sibling checkout.

### Thread 2 log (2026-07-23) — ✅ COMPLETE

**Built** `@redline/redline-domain` entities and ports (zero deps, Result pattern, tests-first).

- **Entities** (`src/entities/`): `procurement-requirement.ts` (fixed `REQUIREMENT_NUMBERS`
  1–6, `ProcurementRequirement` + `makeProcurementRequirement`), `evaluation-structure.ts`
  (`Vendor`, `ResponseGroup`, `IntakeStage` + `makeVendor`/`makeResponseGroup`/`nextIntakeStage`/
  `canAdvanceIntakeStage`), `procurement-response.ts` (`ProcurementResponse` +
  `makeProcurementResponse`), `evaluation.ts` (the `Evaluation` aggregate root + `makeEvaluation`/
  `withIntakeStage`).
- **Ports** (`src/ports/`): `IProcurementExtractionReader`, `IProcurementClassifier`,
  `IFinancialExtractor`, `IEvaluationRepository` — all methods return `Promise<Result<…>>`.
- **Public surface**: `src/index.ts` re-exports all entities + ports alongside the Thread 1
  primitives.

**Design decisions.** (1) *Smart constructors, not classes* — entities are plain readonly
interfaces, invariants live in `make*` factories returning `Result`. (2) *Added an `Evaluation`
aggregate root* — §5 named no root but the `IntakeStage` needed a home and Thread 9 needs a unit
to persist; a minimal `{ id, name, stage }` gap-fill within the plan's model (not an ADR).
(3) *Port DTOs mirror womblex keys* so the Thread 4 reader is a thin mapping.

**Exit test — PASSED.** Run in `node:20-bookworm-slim` via Podman (`flatpak-spawn --host`),
pnpm 9.12.0:
- `redline-domain` test → **6 files, 39/39** (36 new invariant + port-conformance tests; the
  Thread 1 spike still 3/3).
- `./validate.sh` → **9/9**, including check #4 (redline-domain purity: zero non-relative imports).

**Version bump intent:** MINOR — new public surface, no breaking changes (pre-1.0).

**Docs:** [thread-02](./threads/thread-02-redline-domain-entities-and-ports.md).

### Thread 3 log (2026-07-24) — ✅ COMPLETE

**Built** `services/womblex-ingest` — a FastAPI womblex document-extraction sidecar
(foreign-runtime, composed over HTTP + object storage; never imported into the TS
packages), mirroring Wayfinder's `services/australian-writing-mcp` precedent.

- **HTTP surface**: `GET /health`, `POST /ingest` (`{evaluationId, documentNames}` →
  `202 {runId, status, documentCount, shardKeys}`), `GET /status/{run_id}`. Errors are
  Result-shaped (`{error:{code,message}}`) — `INVALID_REQUEST`/`RUN_NOT_FOUND`/`EXTRACTION_FAILED`.
- **Seams**: `ObjectStorage` protocol + boto3 `S3ObjectStorage` (auto-creates the bucket);
  `Extractor` protocol with a deterministic `StubWomblexExtractor` (default) and a lazily
  imported `RealWomblexExtractor`. Shards land under `proc/{evaluationId}/`.
- **Modes**: `WOMBLEX_MODE=stub` (default; no womblex/Isaacus) vs `real` (opt-in image build
  arg `INSTALL_WOMBLEX=1`; Isaacus a further `ISAACUS=1` + runtime key). Real path is
  finalised in Thread 4 alongside the Parquet schema; it fails loudly until then.
- **Infra**: `infra/docker-compose.yml` with `minio` + `womblex-ingest` under the `ingest`
  compose profile; `scripts/thread-03-smoke.sh` runs the exit test end-to-end.

**Decision #4 LOCKED** — [ADR-0002](./adr/0002-own-minio-and-postgres.adr.md): redline owns
its own MinIO and Postgres; the seam stays plain S3/Postgres so a deployment can collapse to a
shared instance by config.

**Design decisions.** (1) *Synchronous runs + in-memory registry* — womblex on a small doc set
is fast; MinIO is the durable record; a queue/worker split is deferred. (2) *Stub is the default*
so the exit test and the air-gap mode run with zero external deps; the real Parquet schema is a
Thread 4 concern. (3) *Result-shaped HTTP errors* map cleanly into the Thread 4 adapter's
`DomainError`.

**Exit test — PASSED.** `podman compose --profile ingest up` (Podman 5.8) against a real MinIO:
`POST /ingest` → `202 succeeded`; `mc ls local/redline/proc/{eval}/` shows `_manifest.parquet`
+ `tender.pdf.elements.parquet` + `pricing.xlsx.elements.parquet` (**shards landed in MinIO**);
`GET /status/{runId}` → `succeeded`; unknown run → `404`. Unit suite **12/12** (isolated venv);
`./validate.sh` → **10/10** incl. new check #10 (womblex-ingest pytest).

**Version bump intent:** MINOR — new service + ADR-0002; no breaking changes (pre-1.0).

**Docs:** [thread-03](./threads/thread-03-womblex-sidecar-service.md).

### Thread 4 log (2026-07-25) — ✅ COMPLETE

**Locked** build-plan §8 decision #2 — the womblex extraction boundary is **JSON**
([ADR-0003](./adr/0003-parquet-to-json-boundary.adr.md)). The `womblex-ingest`
sidecar reads its own Parquet shards and serves a typed JSON read model; the
TypeScript workspace never links a Parquet reader.

**Sidecar (Python) — the Parquet→JSON boundary, server side:**
- New `records.py`: the canonical wire dataclasses (`ElementRecord` / `ChunkRecord` /
  `TableCellRecord` / `DocumentExtraction`), camelCase to mirror the domain DTOs; the
  one place womblex's `source_hash`/`elem_order`/`chunk_id`/currency-cell vocabulary
  is normalised.
- `ExtractionResult` now carries a `documents` read model alongside the Parquet
  `shards`. `POST /ingest` persists each document's JSON as
  `proc/{evaluationId}/{documentId}.extraction.json` beside the shards (durable across
  restart — MinIO is the record, ADR-0002).
- New `GET /extractions/{evaluationId}/{documentId}` read seam (404 `NOT_FOUND` when
  absent). `storage.py` grew `get_object` + `ObjectNotFound`; the stub extractor now
  emits the JSON read model too, so the whole seam is provable offline.
- `real_extractor.py` docstring now pins the Parquet→JSON mapping it must honour;
  still fails loudly until the concrete womblex call surface lands.

**Adapter (TypeScript) — `packages/redline-adapters`:**
- `WomblexExtractionReader implements IProcurementExtractionReader` over an injected
  `HttpClient` (a `fetch`-shaped seam — no global fetch, no Parquet/S3 client). All
  three methods read one document-scoped payload and slice it, sharing provenance.
- `wire.ts` narrows the untrusted JSON (`parseDocumentExtraction`) and maps the
  sidecar's Result-shaped errors (`parseErrorBody`): `NOT_FOUND` passes through, other
  read failures → `EXTRACTION_FAILED`, transport/parse failures → `INFRA_FAILURE` /
  `EXTRACTION_FAILED`. Nothing throws across the port edge.

**Exit test — PASSED.** Contract test reads a **captured** sidecar payload
(`src/womblex/__fixtures__/extraction-tender.pdf.json`, regenerated via the stub) into
typed `ExtractionElement`/`ExtractionChunk`/`ExtractionTableCell`; 8 tests cover the
happy path (incl. URL-encoding + chunkId provenance) and the full error taxonomy.
- Adapter typecheck + lint + **8/8** tests (Node 20 via Podman).
- Sidecar pytest **17/17** (was 12; +5 for the JSON read seam).
- `./validate.sh` → **10/10** (workspace 7/7 incl. adapters; check #10 pytest).

**Design decisions.** (1) *JSON boundary, server-side Parquet* — keeps the TS surface
Parquet-free and confines womblex-schema knowledge to one module, honouring ADR-0001's
"design as if C". (2) *JSON materialised beside the shards* — durable read seam across
a sidecar restart for the price of a small extra object. (3) *Injected `HttpClient`* —
the adapter is unit-testable against a fixture with zero external deps; the fixture is
a real capture so the contract is pinned on both sides.

**Version bump intent:** MINOR — new adapter surface + sidecar read endpoint + ADR-0003;
no breaking changes (pre-1.0).

**Docs:** [thread-04](./threads/thread-04-extraction-reader-adapter.md).

### Fix-forward (2026-07-26) — requirements are user-defined criteria

**Decision.** Reviewing the actual Numbatch (DeepCivic/Numbatch) showed the "fixed 1–6
requirements" model was a misread. Numbatch is a **no-code, user-defined multi-topic
classifier**: a topic = name + description + curated samples → a trained LoRA adapter;
a profile bundles ≤10 topics. The product needs (a) N user-defined requirements/criteria,
(b) each **semantically defined** (the reason we use Numbatch), (c) financial figures
mapped to requirements **without duplication**. Recorded in
[ADR-0004](./adr/0004-user-defined-requirements-not-fixed-1-6.adr.md).

**Fix-forward plan edits (this commit):**
- §1 goal, §2 Numbatch row, §5 data model, §6 financial extension rewritten off the fixed
  1–6 model onto **user-defined `Requirement`/`RequirementSet`** (≤10, mirroring a Numbatch
  profile) and **`requirementId`** in place of `requirementNumber`.
- **Decision #3 LOCKED**: fork Numbatch into `services/numbatch`, run **backend + Arq worker +
  inference** (SvelteKit frontend excluded — redline owns its UI/review), extend the backend for
  financials.
- **New Thread 2a** (domain reshape, tests-first) inserted *before* Thread 5 and marked **next**;
  Thread 5 rewritten as "fork; run all-but-frontend; `NumbatchClassifier` maps topic→requirementId";
  Threads 6–8 re-anchored on `(source_doc_id, topic_id)` financial keys.

**Not yet touched (deliberate — belongs to Thread 2a):** the `redline-domain` *code* still
carries `REQUIREMENT_NUMBERS`/`requirementNumber`. Thread 2a lands the entity/port edits so the
change is tested, not just planned. Thread 5 depends on Thread 2a.

### Thread 2a log (2026-07-26) — ✅ COMPLETE

**Reshaped** `@redline/redline-domain` off the fixed 1–6 model onto user-defined criteria,
enacting [ADR-0004](./adr/0004-user-defined-requirements-not-fixed-1-6.adr.md). Domain-only,
zero deps, tests-first.

- **New `entities/requirement.ts`** (replaces the deleted `procurement-requirement.ts`):
  `Requirement` (`id`/`name`/`definition`) + `makeRequirement` (all trimmed, non-blank);
  `RequirementSet` (`evaluationId` + ordered `requirements`) + `makeRequirementSet`
  (non-empty, unique by `id`, order-preserving, capped at `MAX_REQUIREMENTS_PER_SET = 10`).
- **`ProcurementResponse`**: `requirementNumber` → **`requirementId: string`**; added
  **`confidence: number`** (0–1); dropped `ResponseCategorisation` (the fixed-model bolt-on).
- **Ports**: `RequirementClassification` → `requirementId` (dropped `categorisation`);
  `FinancialExtraction` gains `requirementId` (keyed on `(documentId, requirementId)`).
- **Deletions**: `procurement-requirement.ts` + its test; `grep` confirms no
  `RequirementNumber`/`REQUIREMENT_NUMBERS` remains in `src/`.

**Exit test — PASSED.** `redline-domain` **42/42** (6 files; new `requirement.test.ts` 10,
`procurement-response.test.ts` 10); `./validate.sh` → **10/10** incl. check #4
(redline-domain purity — zero non-relative imports).

**Version bump intent:** MINOR — reshapes an unreleased domain surface (pre-1.0; no consumers yet).

**Docs:** [thread-02a](./threads/thread-02a-generalise-requirements.md).

### Thread 5 log (2026-07-26) — ✅ COMPLETE

**Wired** redline to **Numbatch** (DeepCivic/Numbatch), the user-defined multi-topic
classifier. API shapes verified from the fork's own `docs/ARCHITECTURE.md` /
`docs/DATA_MODEL.md` — not training data.

**Adapter — `packages/redline-adapters/src/numbatch/`:**
- `NumbatchClassifier implements IProcurementClassifier` over an injected method-aware
  `HttpClient` (POST body + GET). One `classifyResponseGroup`: `POST /batch-inference/trigger`
  → poll `GET /batch-inference/jobs/{id}` to `succeeded`/`failed` (bounded) →
  `GET /batch-inference/jobs/{id}/documents` → map each roll-up `topic_id` →
  `requirementId` via an injected `NumbatchProfileBinding`. One `RequirementClassification`
  per (document, matched requirement); unmapped topics dropped; `sourceChunkId` null at the
  per-document roll-up.
- `wire.ts` narrows Numbatch's snake_case wire in one place (`parseBatchJob`,
  `parseDocumentRollup`, `parseErrorBody`); nothing throws across the port edge.

**Service — `services/numbatch/`:** README (vendored fork; backend + worker + inference,
**no frontend**) + idempotent `bootstrap-profile.py` (turns a `RequirementSet` + curated
samples into a trained profile over the API, printing the `NumbatchProfileBinding`).
`infra/docker-compose.yml` gains a `numbatch` profile: postgres/redis/minio/migrate/backend
(:8080)/worker/inference (:8100), no frontend service.

**Decision #3 LOCKED** — [ADR-0005](./adr/0005-numbatch-fork-all-but-frontend.adr.md):
vendor the fork; run all-but-frontend; bootstrap via API; `topic_id ↔ requirementId` only in
the adapter.

**Design decisions.** (1) *Trigger → poll → roll-up in the adapter* — async batch inference
behind a synchronous `Result` port; poll interval/attempts injectable (tests run at 0ms).
(2) *`sourceChunkId: null`* — the roll-up is per document, not per chunk; the domain field is
nullable, so no chunk is invented. (3) *Drop unmapped topics* — the binding is the source of
truth for which topics belong to this evaluation. (4) *Method-aware `HttpClient`* — Numbatch
needs a POST body, unlike the womblex reader's GET-only seam.

**Exit test — PASSED.** Contract test against a **captured Numbatch payload**
(`__fixtures__/batch-rollup.json`): two documents → 3 `RequirementClassification` rows,
`t-data-residency` → `req-data-residency` with confidence ≈ 0.86, full error taxonomy
(failed / timeout / transport / non-2xx). Adapters **17/17** (was 8; +9), `./validate.sh`
**10/10**; `bootstrap-profile.py` `py_compile` clean.

**Known limitation.** No live Numbatch run in this environment (no GPU; fork not yet vendored
on disk) — the exit test is the captured-payload contract test the plan specifies. A
compose-up integration run lands when the fork is checked out (Thread 16).

**Version bump intent:** MINOR — new adapter surface + service scaffold + ADR-0005; no
breaking changes (pre-1.0).

**Docs:** [thread-05](./threads/thread-05-numbatch-integration.md).
