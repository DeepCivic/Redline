# Procurement Evaluation Adapter — Build Plan

> ## ⚠️ DEPRECATED — superseded by [`comprehension-lens-design.md`](./comprehension-lens-design.md)
>
> **This plan is no longer the living delivery document.** It is retained as the
> **delivery history for Threads 1–11** (all ✅ complete) — the thread logs in §10
> remain the authoritative record of what was built and how it was proven.
>
> **Do not add new threads here.** §7 (phased plan) and §10 (progress table) are
> frozen. Outstanding scope — Threads 12–16 and the Next.js shell follow-up — has
> been carried into the design doc under Tracks P and H, alongside the new
> comprehension-lens track (Threads 17–24).
>
> **Why superseded.** Reading the upstream engines showed requirements were
> modelled one tier too shallow (Numbatch's durable topic library was flattened
> into an evaluation-scoped `RequirementSet`), that the retrieval leg we need
> already exists in womblex rather than Numbatch, and that Numbatch's
> `MIN_SAMPLES_PER_TOPIC = 10` training floor conflicts with a definition-only
> first pass. §1 of the design doc sets out all three.
>
> **Still current in this file:** the §8 cross-cutting decisions and their ADRs
> (ADR-0001…0006) remain in force except where the design doc's decision register
> amends them; §2 (upstream tools) and §9 (reused Wayfinder blocks) remain accurate.

A Wayfinder plugin/adapter (its own repo) for procurement evaluation, integrating
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
  — docs: [thread-06](./threads/thread-06-numbatch-financial-schema-and-api.md)
- **Thread 7 — Numbatch extension: financial extraction worker.** Arq stage reads womblex
  table cells for a topic's **matched, deduped** chunks; extracts currency-normalised figures or
  description fallback; writes `financial_extractions` with provenance — one figure per
  (document, requirement), no duplication.
  _Exit: synthetic tender workbook → figures + provenance in DB; unit + integration tests._
  — docs: [thread-07](./threads/thread-07-numbatch-financial-extraction-worker.md)
- **Thread 8 — `IFinancialExtractor` adapter.** `redline-adapters` client pulling `financial_extractions`
  (per document + `requirementId`) into `ProcurementResponse.costing` (`estimateAud: number | null`
  + `description`).
  _Exit: contract test; currency numeric via `typedDisplayCell`._
  — docs: [thread-08](./threads/thread-08-financial-extractor-adapter.md)

### Track 3 — Persistence & orchestration
- **Thread 9 — `redline_` persistence layer.** Drizzle schema + repositories (evaluations, vendors,
  response groups, responses); separate Postgres DB/schema; migrations.
  _Exit: repositories round-trip; migration idempotent._
  — docs: [thread-09](./threads/thread-09-redline-persistence-layer.md)
- **Thread 10 — Orchestration use-cases (`redline-application`).** `IngestDocuments`,
  `AssignDocumentsToGroups`, `ClassifyResponseGroup`, `ExtractFinancials`, `BuildEvaluationTable`.
  One-paragraph AI summary via an `ILanguageModel`-shaped port.
  _Exit: use-case tests with mocked ports produce a full `ProcurementResponse[]`._
  — docs: [thread-10](./threads/thread-10-orchestration-use-cases.md)

### Track 4 — Control surface & review (apps/redline-web)
- **Thread 11 — Workflow manager UI (specialist control surface).** Drag docs → response groups;
  mark consortium; split multi-bid vendors; drive `IntakeStage`; trigger (re)classification per group.
  _Exit: specialist can compose the three relationship shapes and advance stages._
  — docs: [thread-11](./threads/thread-11-workflow-manager-ui.md)
- **Thread 12 — In-app review grid (priority 1).** Sortable/filterable table reusing
  `field-report-view` typed cells; source column deep-links to document location; all required columns.
  _Exit: real evaluation renders; currency sorts numerically; source links resolve._
  — docs: [thread-12](./threads/thread-12-in-app-review-grid.md)
- **Thread 13 — Pricing pivots.** Reuse `computePivot` for per-brand and per-requirement/criterion
  rollups (sum/avg of `estimateAud`); axis selection (brand, requirement, brand×requirement).
  _Exit: pivot matches hand-computed totals on a fixture._
  — docs: [thread-13](./threads/thread-13-pricing-pivots.md)
- **Thread 14 — Excel export (priority 2).** "Export to Excel" reusing Wayfinder's XLSX path so
  currency stays numeric; one sheet for the table, one per pivot.
  _Exit: workbook opens with numeric currency + working document links._
  — docs: [thread-14](./threads/thread-14-excel-export.md)

### Track 5 — Hardening & handover
- **Thread 15 — Isaacus-optional & air-gap validation.** Prove womblex non-Isaacus path end-to-end;
  document both modes; surface as a UI config toggle. _Exit: full pipeline runs with `ISAACUS_API_KEY` unset._
  — docs: [thread-15](./threads/thread-15-isaacus-optional-and-air-gap.md)
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
5. **Auth/roles** — **LOCKED: inherit Wayfinder's** — redline reuses Wayfinder's identity (Better Auth / Entra ID) and its `Role`/`PermissionKey` model rather than building its own; the current-user/principal is an injected **port** consumed at the `redline-application` / `apps/redline-web` edge (wired in `lib/container.ts`), so `redline-domain` stays identity-free. Procurement actions map onto Wayfinder permissions; genuinely new keys go **upstream**, not forked. Numbatch's UI is not an auth reference (ADR-0005). Recorded in [ADR-0006](./adr/0006-inherit-wayfinder-auth-roles.adr.md).

> **ADR model adopted.** This repo now follows Wayfinder's ADR format under
> [`docs/adr/`](./adr/README.md).

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
| 6 — Numbatch financial_profile schema & API | ✅ **done** | Exit test **PASSED**: `POST /financial-profiles` creates a profile for a topic → `201` with the persisted body (idempotent by `topic_id` → re-`POST` `200`); the Alembic revision applies through a real `Operations` context — both tables created, `(source_doc_id, topic_id)` uniqueness enforced, `downgrade` reverses. Additive overlay `services/numbatch/financial_extension/` (SQLAlchemy 2.0 models `FinancialProfile`/`FinancialExtraction`, Pydantic v2 schemas, `FinancialProfileRepository`, config router, migration) written to graft onto the fork unchanged (Thread 16); provable standalone against SQLite — no GPU/fork on disk (ADR-0005). **11/11** pytest; `./validate.sh` **11/11** (new check #11). Docs: [thread-06](./threads/thread-06-numbatch-financial-schema-and-api.md). |
| 7 — Numbatch financial extraction worker | ✅ **done** | Exit test **PASSED**: a synthetic tender workbook (womblex currency cells for a matched topic) → the worker writes one `financial_extractions` row per (document, requirement) with figure + `elem_order` provenance (`$1,200.50` + `$300.00` → `1500.50 AUD`, `source_elem_order 7`); no-currency topic → description fallback (`amount NULL`); double-run proves the `(source_doc_id, topic_id)` no-duplication invariant; unconfigured topics skipped. Additive to the Thread 6 overlay: `extractor.py` (pure figure logic — bundle sum vs line-item first, currency normalisation), `extraction_repository.py` (`upsert` enforcing no-duplication in code), `womblex_source.py` (`WomblexSource` protocol + in-memory fake), `worker.py` (`extract_financials_for_document` + the `financial_extraction_task` Arq entrypoint — no `arq` runtime dep; wired in the fork at Thread 16). **24/24** pytest (was 11; +13); `./validate.sh` **11/11**. Provable standalone against SQLite — no GPU/fork on disk (ADR-0005). Docs: [thread-07](./threads/thread-07-numbatch-financial-extraction-worker.md). |
| 8 — IFinancialExtractor adapter | ✅ **done** | Exit test **PASSED**: `NumbatchFinancialExtractor` (`redline-adapters`) reads `financial_extractions` per (document, `requirementId`) into `ProcurementResponse.costing` (`estimateAud: number \| null` + `description` + `elementOrder`), mapping Numbatch `topic_id` → `requirementId`; the currency figure is a real number and the contract test proves it numeric via Wayfinder's `typedDisplayCell("currency", …)` → `{ value: 1500.5, isNumeric: true }`. 9 contract tests against a **captured read-seam payload** (`__fixtures__/document-extractions.json`) cover the happy path, description fallback (null estimate), multi-doc concat, unmapped-topic drop, empty-document, and the error taxonomy (INFRA_FAILURE / EXTRACTION_FAILED). Additive read seam added to the Thread 6/7 overlay: `GET /financial-extractions/{source_doc_id}` (`DocumentExtractionsRead`; empty-not-404). adapters **26/26** (was 17; +9); financial extension pytest **28** (was 24; +4); `./validate.sh` **11/11**. Docs: [thread-08](./threads/thread-08-financial-extractor-adapter.md). |
| 9 — redline_ persistence layer | ✅ **done** | Exit test **PASSED**: `DrizzleEvaluationRepository` (`redline-adapters`) round-trips the evaluation aggregate (evaluations/vendors/response-groups/responses) against a **real in-process Postgres** (PGlite = Postgres-in-WASM, no external service); currency round-trips as a real `number` (`numeric(18,2)` ↔ decimal string ↔ `number \| null`), consortium members + id arrays preserved, `NOT_FOUND` on miss, upsert-on-save. The initial `redline_` migration (`0000_redline_initial.sql`, hand-authored to mirror `schema.ts`) is **idempotent** — the exit test re-applies it as a no-op and the schema still works. 15 tests (7 pure row-mapping + 8 round-trip/idempotency) → adapters **41/41** (was 26; +15). Four `redline_`-prefixed tables (check #7 green), `db.ts`/`migrate.ts`/`apply-migrations.ts` + `drizzle.config.ts`; `redline` compose profile (`redline-postgres`). Enacts [ADR-0002](./adr/0002-own-minio-and-postgres.adr.md). `./validate.sh` **11/11**. Docs: [thread-09](./threads/thread-09-redline-persistence-layer.md). |
| 10 — Orchestration use-cases | ✅ **done** | Exit test **PASSED**: `BuildEvaluationTable` (`@redline/redline-application`) joins the classifier roll-ups + financial extractions + an `ILanguageModel` summary into a full `ProcurementResponse[]` (one row per (group, document, matched requirement)), persists them and advances the stage `classifying → review`; currency stays a real `number` (`estimateAud 1500.5`) with `elementOrder 7` / `chunkId` provenance. Five use-cases (`IngestDocuments`, `AssignDocumentsToGroups`, `ClassifyResponseGroup`, `ExtractFinancials`, `BuildEvaluationTable`) inject only `redline-domain` ports — no frameworks/ORM/AI SDK (check #5 green). New domain port `ILanguageModel` (the one-paragraph summary seam). application **16/16** (4 files), domain **43/43** (+1 port), `./validate.sh` **11/11**. Docs: [thread-10](./threads/thread-10-orchestration-use-cases.md). |
| 11 — Workflow manager UI | ✅ **done** | Exit test **PASSED**: `apps/redline-web` — a framework-free control surface. `WorkflowManager` (pure state) composes the three relationship shapes (1 vendor→N docs→1 response; N vendors→1 consortium; 1 vendor→N responses), validating through the domain's `makeVendor`/`makeResponseGroup` so the UI can't compose a shape the app layer rejects; `WorkflowController` (`src/lib/container.ts`, injected ports only) drives `AssignDocumentsToGroups` (grouping→classifying), `ClassifyResponseGroup` (re-run per group), and `BuildEvaluationTable` (classifying→review); `view.ts` is the pure snapshot→view-model transform. redline-web **18/18** (3 files: manager 11, container 5, view 2); workspace typecheck/lint/test/build green across 5 `@redline/*` packages; `./validate.sh` **11/11**. Playwright spec authored (`e2e/`); executable gate is vitest until a Next.js shell serves the routes (CLAUDE.md `/e2e` deviation updated). Docs: [thread-11](./threads/thread-11-workflow-manager-ui.md). |
| 12 — In-app review grid | ✅ **done** | Exit test **PASSED**: `apps/redline-web` — the sortable/filterable review grid as a framework-free core (ADR-0006; a Next.js/React shell binds to it). `ReviewGrid` (`src/lib/review-grid.ts`) turns the Thread 10 `ProcurementResponse[]` into typed rows (one per (group, document, matched requirement)) with all required columns (vendor / product / requirement / confidence / summary / estimate (AUD) / costing / source); currency stays a real number so it **sorts numerically** (`[90,100,1000]`, not lexical), pinned against Wayfinder's `typedDisplayCell` (`isNumeric:true`); null estimates cluster non-numeric. `renderReviewGridView` (`src/lib/review-view.ts`) resolves the **source deep-link** (`/evaluations/:id/documents/:doc?element=…&page=…&chunk=…`) + header sort state + filters. `WorkflowController.openReviewGrid` reads persisted responses (`listResponses`). redline-web **33/33** (was 18; +15: review-grid 8, review-view 5, container +2); Playwright spec `e2e/review-grid.e2e.ts` authored (vitest is the gate until the shell lands). `./validate.sh` **11/11**. Docs: [thread-12](./threads/thread-12-in-app-review-grid.md). |
| 13 — Pricing pivots | ✅ **done** | Exit test **PASSED**: `PricingPivot` (`apps/redline-web`) rolls the Thread 10/12 `ProcurementResponse[]` up per brand, per requirement, and brand×requirement, summing/averaging the real-number `estimateAud`; on a five-row fixture (3 vendors × 2 requirements + one null-estimate fallback) the totals match hand-computed values (per-brand sum Initech 3000/Globex 2000/Acme 1500, grand 6500 over 4 samples; per-brand avg Acme 750; per-requirement residency 6000/support 500; brand×requirement Acme×residency 1000/×support 500) and are **cross-checked against Wayfinder's own `computePivot`** (read-only reuse §9, test-only — production app code imports nothing from Wayfinder, matching Thread 12's `typedDisplayCell` posture). Null-estimate rows are non-samples (excluded from sum, not an avg denominator, blank not `$0.00`); all-fallback → `hasNumericData:false`. `renderPivotView` shapes the table (axis/measure headers, one column per secondary group); `WorkflowController.openPricingPivot` reads persisted responses. redline-web **45/45** (was 33; +12: pricing-pivot 7, pricing-view 4, container +1); Playwright spec `e2e/pricing-pivots.e2e.ts` authored (vitest is the gate until the shell lands). `./validate.sh` **11/11**. Docs: [thread-13](./threads/thread-13-pricing-pivots.md). |
| 14 — Excel export | ✅ **done** | Exit test **PASSED**: `apps/redline-web` — the Excel export as a framework-free core (a thin lazy `write-excel-file/browser` trigger binds to it; ADR-0006). `buildReviewSheetData` / `buildPivotSheetData` / `buildEvaluationWorkbook` (`src/lib/excel-export.ts`) turn the Thread 12 `ReviewGrid` + Thread 13 `PricingPivot` into `write-excel-file` sheet data — reusing Wayfinder's cell shape (`{ value, type: String\|Number, fontWeight? }`\|`null`, plan §9, verified against the library's bundled types not training data) so **currency writes as a real `Number` cell** (review estimate `1000`, confidence `0.86`, pivot totals — cross-checked against `typedDisplayCell("currency",…)` → `isNumeric:true`), a null estimate writes a **blank** cell (never `0`), and the **source column is a working hyperlink** to the exact document location (`/evaluations/:id/documents/:doc?element=…&page=…&chunk=…`, the same deep-link the in-app grid resolves). One `Review` sheet + one sheet per pivot (`Pricing by Vendor` / `Pricing by Requirement` / `Vendor × Requirement`). `WorkflowController.buildWorkbook` reads persisted responses (read-only); `exportEvaluationXlsx` is the lazy browser writer (dynamic import, `{ name, data }[]` sheets → `.toFile`), mirroring Wayfinder's `exportInsightsXlsx`. redline-web **58/58** (was 45; +13: excel-export 11, container +2); `write-excel-file@^4.1.1` added to `redline-web`. Playwright spec `e2e/excel-export.e2e.ts` authored (vitest is the gate until the shell lands). `./validate.sh` **11/11**. Docs: [thread-14](./threads/thread-14-excel-export.md). |
| 15 — Isaacus-optional & air-gap validation | ✅ **done** | Exit test **PASSED**: the full pipeline runs with `ISAACUS_API_KEY` **unset**. `services/womblex-ingest` now models Isaacus-optionality explicitly — `Settings.enrichment_mode` (`offline` \| `isaacus`) derives from `WOMBLEX_MODE` + a non-blank key (**stub always offline**; **real offline unless a key is present**), surfaced on `GET /health` (`womblexMode`/`enrichmentMode`/`isaacusEnabled`) so a deployment + the UI toggle can read the live path. Proven twice: `tests/test_airgap_pipeline.py` builds the app at startup with the key deleted (S3 faked) and drives the whole seam (`POST /ingest` → shards land → `GET /extractions/...` serves JSON) reporting `offline`; live counterpart `scripts/thread-15-airgap.sh` (real MinIO). UI: `apps/redline-web` `renderIngestConfigView`/`parseIngestHealth` — a pure view-model (extraction/enrichment labels, `airGapped`, an Isaacus toggle **disabled on the stub path**). womblex-ingest pytest **27** (was 17; +10: enrichment 6, air-gap 2, health +3, −1 stub-doc reword); redline-web **63** (was 58; +5). `./validate.sh` **11/11**. Docs: [thread-15](./threads/thread-15-isaacus-optional-and-air-gap.md). |
| 16 — Workspace extraction & release prep | 🔵 **next** | |

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

### Thread 6 log (2026-07-27) — ✅ COMPLETE

**Extended** the forked Numbatch backend (additively — ADR-0005) with the financial
extension's **schema + config API**. Built as a self-contained overlay at
`services/numbatch/financial_extension/`, written to graft onto the fork's `app/` +
`alembic/` layout unchanged, but buildable and testable **without the GPU-bearing fork
vendored on disk** (same posture as Thread 5's captured-payload contract test).

**Schema (`src/numbatch_financial/models.py`) — two additive tables:**
- `financial_profiles` — per Numbatch topic (= a redline requirement, ADR-0004): config for
  *what* monetary facts to pull (`target_currency`, `cost_basis` one-off/recurring,
  `granularity` line-item/bundle). Unique per `topic_id` (one live profile per requirement).
- `financial_extractions` — the Thread 7 worker's output (`amount`/`currency`/`description`
  fallback + `source_elem_order` provenance). **`uq_financial_extractions_doc_topic
  (source_doc_id, topic_id)`** enforces the no-duplication invariant (build plan §6). Declared
  now so the migration creates both tables in one additive step; Thread 7 only adds the writer.

**Config API (`api.py`, `schemas.py`, `repository.py`):** `POST /financial-profiles`
(idempotent by `topic_id`: existing → `200`, new → `201`), `GET /financial-profiles`,
`GET /financial-profiles/{id}` (`404` `NOT_FOUND`). Pydantic v2 DTOs (ISO-4217 `^[A-Z]{3}$`).
Result-shaped errors (`{error:{code,message}}`) mirror the womblex sidecar, mapping cleanly
into the Thread 8 adapter's `DomainError`.

**Migration (`migrations/redline_financial_0001_financial_tables.py`):** the additive Alembic
revision creating both tables + indexes + unique constraints, with a `downgrade`.
`down_revision = None` for standalone testing; repointed at Numbatch's head when vendored
(Thread 16).

**Design decisions.** (1) *Overlay, not a fork edit* — the fork isn't on disk (ADR-0005; no
GPU); rather than block on Thread 16, the extension is a package written to drop in unchanged
(local `Base` swaps for Numbatch's; router mounts via `include_router`). (2) *Both tables in
one migration* — atomic additive change; Thread 7 adds only the worker that inserts rows.
(3) *Idempotent by `topic_id`* — same "safe to re-run" contract as the profile bootstrap
(ADR-0005). (4) *Uniqueness in the schema* — `uq_financial_extractions_doc_topic` enforces
no-duplication, and the migration test proves the constraint bites.

**Exit test — PASSED.** `services/numbatch/financial_extension` pytest **11/11**:
`test_config_api.py` (8) creates a profile for `topic-data-residency` → `201` with the
persisted body (**create a financial profile via API**) + idempotency/list/read/`404`/`422`;
`test_migration.py` (3) applies the Alembic revision through a real `Operations` context —
both tables created, `(source_doc_id, topic_id)` uniqueness enforced, downgrade reverses
(**migration passes CI**). `./validate.sh` → **11/11** (new check #11).

**Known limitation.** No live Postgres `alembic upgrade head` against the vendored fork in this
environment (no GPU; fork not on disk — ADR-0005); the exit test runs the overlay against
SQLite. Grafting into the fork (bind to Numbatch's `Base`, repoint `down_revision`,
`include_router`) is a Thread 16 mechanical step, documented in the overlay README.

**Version bump intent:** MINOR — additive backend schema + config API; no breaking changes
(pre-1.0).

**Docs:** [thread-06](./threads/thread-06-numbatch-financial-schema-and-api.md).

### Thread 7 log (2026-07-28) — ✅ COMPLETE

**Added** the financial extension's **Arq worker stage** (build plan §6) — the writer that
fills `financial_extractions` (the table itself was created by the Thread 6 migration).
Additive to the Thread 6 overlay at `services/numbatch/financial_extension/`; same standalone
posture (SQLite + an in-memory womblex fake; no MinIO, no GPU, no vendored fork — ADR-0005).

**New modules (`src/numbatch_financial/`):**
- `extractor.py` — the **pure** logic. `MatchedCell` (a womblex table cell: `elem_order`,
  `raw_value`, `is_currency`) + `extract_figure(profile, matched_cells, fallback_text)` →
  `ExtractionFigure`. Currency cells are parsed (symbol/grouping stripped); a *bundle* profile
  sums them, a *line-item* profile takes the first (lowest `elem_order`) figure; provenance
  points at the first matched currency cell. No currency cell → a description-only fallback
  (`amount`/`currency` = `None`). No I/O.
- `extraction_repository.py` — `ExtractionFigure` DTO + `FinancialExtractionRepository`. `upsert`
  enforces the `(source_doc_id, topic_id)` no-duplication invariant **in code** (update the
  existing row in place), so a re-run never duplicates nor trips
  `uq_financial_extractions_doc_topic`.
- `womblex_source.py` — `MatchedTopic` (a matched topic + its deduped chunk ids), the
  `WomblexSource` **protocol** (matched currency cells + fallback text), and an in-memory
  `FakeWomblexSource` so the stage is provable standalone. In the fork the seam resolves through
  Numbatch's ingestion store and the roll-up's matched chunk ids.
- `worker.py` — `extract_financials_for_document` (load each matched topic's `financial_profile`,
  pull its cells + fallback, extract, upsert; one transaction per document; topics without a live
  profile skipped) + `financial_extraction_task(ctx, …)` the Arq entrypoint the fork registers
  (Thread 16). No `arq` runtime dependency — the entrypoint takes a plain `ctx` dict.

**Design decisions.** (1) *Pure extractor + thin repository + womblex seam* — mirrors redline's
hexagonal seams (the TS adapters inject an `HttpClient`; here the worker injects a `WomblexSource`
+ `session_factory`), keeping the worker a short orchestration and the monetary logic I/O-free.
(2) *No-duplication in `upsert`, not the caller* — the §6 invariant is both a schema constraint
(Thread 6) and a repository behaviour; the double-run test proves one row per pair. (3) *`amount`
OR `description`* — serves the "dollar estimate **or** short description" rule (§1). (4) *Bundle
vs line-item honours `granularity`.* (5) *No `arq` dep* — Arq stays a deployment concern wired in
the fork's `WorkerSettings` (Thread 16), keeping the overlay dependency-light and standalone-provable.

**Exit test — PASSED.** `services/numbatch/financial_extension` pytest **24/24** (was 11; +13):
`test_extractor.py` (6) pure figure logic; `test_extraction_repository.py` (3) upsert /
no-duplication write side; `test_worker.py` (4) — **the exit test** — a synthetic tender workbook
(`$1,200.50` @ `elem_order 7` + `$300.00` @ `elem_order 9` for matched `t-support`) → one
`financial_extractions` row `amount 1500.50`, `currency AUD`, `source_elem_order 7` (**figures +
provenance in DB**); no-currency topic → description fallback (`amount NULL`); double-run → one
row per matched topic (no duplication); unconfigured topics skipped. `./validate.sh` → **11/11**.

**Known limitation.** No live Numbatch compose-up here (no GPU; fork not on disk — ADR-0005); the
exit test runs the worker against SQLite + `FakeWomblexSource`. Wiring the real seam over
Numbatch's ingestion store and enqueuing `financial_extraction_task` from the roll-up land with
the vendored fork (Thread 16), documented in the overlay README.

**Version bump intent:** MINOR — additive Arq worker stage over the Thread 6 schema; no breaking
changes (pre-1.0).

**Docs:** [thread-07](./threads/thread-07-numbatch-financial-extraction-worker.md).

### Thread 8 log (2026-07-29) — ✅ COMPLETE

**Built** `NumbatchFinancialExtractor` (`packages/redline-adapters`) — the
`IFinancialExtractor` implementation that pulls the Thread 7 worker's
`financial_extractions` into `ProcurementResponse.costing`, and added the additive
HTTP **read seam** the adapter reads from.

**Read seam (Python overlay, `services/numbatch/financial_extension/`):** Thread 7
*wrote* rows but exposed no read endpoint. Added `GET
/financial-extractions/{source_doc_id}` (`build_extractions_router` in `api.py`,
mounted alongside the config router) returning `DocumentExtractionsRead`
(`schemas.py`). An unknown document is a **200 + empty list**, not a 404 — "no
figures yet" is a valid empty costing set. Reuses `list_for_doc`; +4 pytest
(`test_extraction_read_api.py`).

**Adapter (`packages/redline-adapters/src/numbatch/`):**
`numbatch-financial-extractor.ts` (GET-only `HttpClient`; reads each document in
the group; maps `topic_id → requirementId` via a narrowed `NumbatchProfileBinding`;
drops unmapped topics) + `financial-wire.ts` (narrows the read seam's wire in one
place — Pydantic serialises the `Numeric` `amount` as a **decimal string**, parsed
to a JS number here; malformed → `EXTRACTION_FAILED`) + a captured fixture
(`__fixtures__/document-extractions.json`).

**Design decisions.** (1) *Currency stays numeric* — the wire parses the decimal
string so `estimateAud` is a real `number | null`; the exit test feeds it through
`typedDisplayCell("currency", …)` and asserts `isNumeric: true`, the property
Threads 13–14 need. (2) *`topic_id → requirementId` only in the adapter* (ADR-0005),
via the same binding as the Thread 5 classifier. (3) *Empty-not-404* — a document
with no extractions yields `[]`, so a partially-processed group reads cleanly.
(4) *`elementOrder` defaults to `0` for a description fallback* — `estimateAud:
null` is the load-bearing fallback signal. (5) *GET-only `HttpClient`* — the read
seam takes no body, reusing the womblex reader's seam shape.

**Exit test — PASSED.** Contract test against a **captured read-seam payload**:
`t-data-residency` → `req-data-residency`, `estimateAud 1500.5`, `elementOrder 7`;
the exit criterion `typedDisplayCell("currency", "1500.5")` → `{ value: 1500.5,
isNumeric: true }`; description fallback keeps `estimateAud: null`; multi-doc
concat; unmapped-topic drop; empty-document → `[]`; full error taxonomy. adapters
**26/26** (was 17; +9), financial extension pytest **28** (was 24; +4),
`./validate.sh` **11/11**.

**Known limitation.** No live Numbatch compose-up here (no GPU; fork not on disk —
ADR-0005); the read endpoint is proven standalone against SQLite and the adapter
against the captured payload. Grafting the read router onto the fork
(`include_router`) is the Thread 16 mechanical step, alongside the Thread 6/7
overlay.

**Version bump intent:** MINOR — new adapter surface + additive read endpoint; no
breaking changes (pre-1.0).

**Docs:** [thread-08](./threads/thread-08-financial-extractor-adapter.md).

### Thread 9 log (2026-07-30) — ✅ COMPLETE

**Built** the `redline_` persistence layer (`packages/redline-adapters/src/persistence/`):
Drizzle schema + `DrizzleEvaluationRepository` (`IEvaluationRepository`) over a
redline-owned Postgres (ADR-0002).

**Schema (`schema.ts`).** Four `redline_`-prefixed tables — `redline_evaluations`,
`redline_vendors`, `redline_response_groups`, `redline_responses` — snake_case,
`id`/`created_at`/`updated_at` on each; currency `numeric(18,2)`; id sets as
`text[]`; FKs cascade from the evaluation. `row-mapping.ts` is the pure domain ↔
row layer (the numeric decimal-string ↔ `number | null` conversion lives here).

**Repository (`drizzle-evaluation-repository.ts`).** Result at every boundary
(driver errors → `INFRA_FAILURE`, missing → `NOT_FOUND`); saves are upserts so a
re-run of a stage is idempotent; the drizzle handle is injected structurally so
postgres-js (prod) and PGlite (test) both satisfy it. `db.ts`
(`createRedlinePostgres`), `migrate.ts` (`db:migrate` against `DATABASE_URL`),
`apply-migrations.ts` (driver-agnostic), `drizzle.config.ts`, and the initial
migration `0000_redline_initial.sql` (idempotent, `IF NOT EXISTS`).

**Design decisions.** (1) *PGlite for the exit test* — no local Node/Postgres, but
"round-trip" needs real Postgres, so [PGlite](https://pglite.dev) (Postgres-in-WASM)
runs in-process under vitest via `drizzle-orm/pglite`; arrays, `numeric` decimal
strings and FKs behave for real with zero external services (same standalone
posture as Threads 5–7). (2) *One migration SQL for tests and prod* —
`applyMigrations` runs against PGlite in the test and `DATABASE_URL` in `migrate.ts`;
the idempotency test literally re-runs it. (3) *Upsert-on-save* — matches the
re-classify / advance-stage flows Thread 10 drives. (4) *Currency numeric end to
end* — consistent with the Thread 8 adapter and the review grid / pivots to come.

**Exit test — PASSED.** adapters **41/41** (was 26; +15: 7 pure row-mapping + 8
round-trip/idempotency against PGlite). Round-trips the whole aggregate, reads
currency back as `1500.5`, preserves consortium members + id arrays, `NOT_FOUND`
on miss, scopes by evaluation; the final test re-applies the migration as a no-op
and confirms the schema still works. `./validate.sh` **11/11** (incl. #7 `redline_`
prefix).

**Known limitation.** No live Postgres `db:migrate` run here (no local Node/DB);
the migration is proven idempotent against real Postgres semantics via PGlite, and
the `redline` compose profile + `migrate.ts` are wired for a real run when Node is
present (Thread 10/11 or Thread 16). `0000_redline_initial.sql` is hand-authored
(mirrors `schema.ts`); regenerate via `db:generate` on the next schema change.

**Version bump intent:** MINOR — new persistence surface + own Postgres; no
breaking changes (pre-1.0).

**Docs:** [thread-09](./threads/thread-09-redline-persistence-layer.md).

### Thread 10 log (2026-07-31) — ✅ COMPLETE

**Built** the orchestration layer `@redline/redline-application` (build plan §5 /
Track 3): five use-cases that inject only `redline-domain` ports — no frameworks,
no ORM, no AI SDK (CLAUDE.md architecture rule; `validate.sh` check #5 green) — so
every step is unit-testable with in-memory fakes.

**New domain port** — `packages/redline-domain/src/ports/language-model.ts`:
`ILanguageModel.summarise(SummaryRequest) → Promise<Result<string>>`, the
one-paragraph product-summary seam. The summary is AI-shaped but the application
layer must not import an AI SDK, so the seam lives in the domain and the concrete
model adapter is a later thread's concern.

**Use-cases** — `packages/redline-application/src/use-cases/`:
- `IngestDocuments` — confirms every document reads back through the extraction
  reader; persists the evaluation and advances `documents_uploaded → grouping` (does
  not trigger womblex — that is the sidecar's job, Thread 3).
- `AssignDocumentsToGroups` — persists vendors + response groups (consortium
  detection via `makeResponseGroup`); advances `grouping → classifying`; rejects a
  group referencing an undeclared vendor.
- `ClassifyResponseGroup` / `ExtractFinancials` — thin pass-throughs to the
  classifier / financial-extractor ports so a UI (Thread 11) can (re)run each step.
- `BuildEvaluationTable` — **the composition**: per response group, joins classifier
  roll-ups (confidence + chunk) + financial extractions (keyed
  `documentId::requirementId`) + an `ILanguageModel` summary over the matched
  passages into one `ProcurementResponse` per (group, document, matched requirement)
  via `makeProcurementResponse`, persists them (`saveResponses`), and advances
  `classifying → review`. Currency stays a real `number | null` end-to-end.
- `in-memory-evaluation-repository.test-support.ts` — a shared `IEvaluationRepository`
  fake (excluded from the build; no `describe`), reused across the suites.

**Design decisions.** (1) *Use-cases inject ports, never construct adapters* — the
app container wires the real adapters (Thread 11), keeping the layer
framework/ORM/SDK-free and the exit test off Numbatch/DB/model. (2) *`ILanguageModel`
is a domain port* implemented by an adapter later. (3) *`BuildEvaluationTable`
composes the two thin use-cases* so the named steps a UI drives and the table
builder share one path. (4) *Stage transitions via `withIntakeStage`, persist only on
success* — a mid-flight failure leaves the evaluation untouched (no half-advanced
state). (5) *Costing fallbacks* — a null-estimate extraction keeps its description; a
match with no extraction gets a `"no costing extracted yet"` fallback so the
estimate-or-description invariant always holds.

**Exit test — PASSED.** `build-evaluation-table.test.ts` seeds an evaluation at
`classifying` with one vendor + group, wires in-memory classifier / financial
extractor / extraction reader / language-model fakes, and asserts the produced
`ProcurementResponse[]`: `vendorName "Acme"`, `requirementId "req-data-residency"`,
`confidence 0.86`, `costing.estimateAud 1500.5` (a **real number**),
`source.elementOrder 7`, `source.chunkId "doc-a:2"`, a summary condensing the matched
passages — then confirms the row was persisted and the stage advanced to `review`.
Further cases: null-estimate fallback, empty-extraction fallback, propagated
classifier failure (nothing persisted, stage unchanged), and the stage guard.
application **16/16** (4 files); domain **43/43** (+1 for the `ILanguageModel` port);
`./validate.sh` **11/11**.

**Known limitations.** (1) No concrete `ILanguageModel` adapter yet — the port is
proven with a fake; the real summariser lands with Thread 11 wiring or a dedicated
adapter thread. (2) One `productName` per evaluation (per-group names are a Thread 11
concern). (3) Summary passages are all of a document's chunks; narrowing to the
requirement's matched chunks needs per-chunk provenance the roll-up port doesn't yet
carry. (4) No live end-to-end run (no Numbatch/DB/model here) — same standalone
posture as Threads 5–9.

**Version bump intent:** MINOR — new application surface (first use-cases) + one new
domain port; no breaking changes (pre-1.0).

**Docs:** [thread-10](./threads/thread-10-orchestration-use-cases.md).

### Thread 11 log (2026-08-01) — ✅ COMPLETE

**Built** the specialist **control surface** as the workspace's first app,
`apps/redline-web` (build plan §5 / Track 4). Framework-free: the workflow logic
lives in a pure, unit-tested core; a Next.js/React shell (a Track 4 follow-up,
matching Wayfinder's `apps/web` — ADR-0006)
binds to it. The app imports only `@redline/redline-application` (use-cases) and
`@redline/redline-domain` (ports/types); the concrete adapters are injected as
ports through `src/lib/container.ts` — the one place wiring lives.

**Modules (`apps/redline-web/src/lib/`):**
- `workflow-manager.ts` — the **brain**. A pure, in-memory model of "drag documents
  into response groups": `addVendor`, `createGroup`, `assignDocument` (a doc lives in
  exactly one group — dropping it on another *moves* it), `unassignDocument`,
  `markConsortium`, `toAssignmentInput()`, `canAdvance()`/`nextStage()`, `snapshot()`.
  Every mutation validates through the same `redline-domain` smart constructors
  (`makeVendor`, `makeResponseGroup`) the use-case uses, so the UI can never compose
  a shape the application layer would reject.
- `container.ts` — `WorkflowController` wires `AssignDocumentsToGroups`,
  `ClassifyResponseGroup`, `BuildEvaluationTable` from injected ports and drives the
  workflow (`openWorkflow`, `advance`, `reclassifyGroup`, `buildTable`).
  `buildContainer` is the production-wiring factory.
- `view.ts` — pure snapshot → view-model transform the shell binds to (stage label,
  document tray, per-group counts + consortium badge, the advance affordance).
- `index.ts` — public surface; `e2e/workflow-manager.e2e.ts` — Playwright acceptance
  spec (excluded from tsc/lint/vitest scope).

**The three relationship shapes** (build plan §5) all compose: 1 vendor→N docs→1
response; N vendors→1 consortium response (`isConsortiumResponse` + `markConsortium`
recording members); 1 vendor→N responses (same vendor across groups).

**Design decisions.** (1) *Framework-free, unit-tested core; a dumb DOM* — the
interesting logic is out of untestable markup, so the exit criterion is provable
without a browser. (2) *The UI reuses the domain's smart constructors* — a bad
composition fails at composition time, not later in the use-case. (3) *A document
belongs to exactly one group* — `assignDocument` moves it. (4) *Wiring is one factory
+ injected ports* — the controller/manager never see a concrete adapter, exercised
with in-memory fakes (same standalone posture as Threads 5–10). (5) *`/e2e` deviation
recorded* — the Playwright spec is authored now; its executable gate is the vitest
suite until a Next.js shell serves the routes (CLAUDE.md deviations table updated).

**Exit test — PASSED.** redline-web **18/18** (3 files: `workflow-manager.test.ts` 11
— the three shapes + move/unassign + validation + advance eligibility;
`container.test.ts` 5 — open/advance `grouping→classifying`, refuse empty, reclassify,
build table `classifying→review` with a real `estimateAud`; `view.test.ts` 2). Full
workspace typecheck/lint/test/build green across 5 `@redline/*` packages;
`./validate.sh` → **11/11**.

**Known limitations.** (1) No Next.js shell yet — the logic is complete and tested;
the route/DOM layer + the Playwright run are a Track 4 follow-up (the e2e spec pins
the DOM contract). (2) One `productName` per evaluation (carried from Thread 10).
(3) No live end-to-end run (no Numbatch/DB/model/browser here). (4) Plan decision #5
(auth/roles) still open — decide before the shell ships.

**Version bump intent:** MINOR — new app surface; no breaking changes (pre-1.0).

**Docs:** [thread-11](./threads/thread-11-workflow-manager-ui.md).

### Thread 12 log (2026-08-02) — ✅ COMPLETE

**Built** the priority-1 **in-app review grid** in `apps/redline-web` (build plan
§1 / §5 / Track 4). Same posture as Thread 11: a framework-free, unit-tested core
a thin Next.js/React shell binds to (ADR-0006 — matching Wayfinder's own
`apps/web`, not Numbatch's unused SvelteKit).

**Modules (`apps/redline-web/src/lib/`):**
- `review-grid.ts` — the **grid brain**, `ReviewGrid`. Turns the Thread 10
  `ProcurementResponse[]` into typed `ReviewRow`s (one per (group, document,
  matched requirement)), `REVIEW_COLUMNS` in display order with every required
  column (vendor / product / requirement / confidence / summary / estimate (AUD) /
  costing / source). Each cell resolves to `{ display, sortValue, isNumeric }`;
  `view({ sort, filter })` returns the sorted/filtered rows, `all()` the default,
  `requirementIds()` the filter options. Currency stays a real number so it sorts
  **numerically**; a null estimate (Thread 10 description-fallback signal) is never
  numeric and clusters at the numeric floor. Stable sort; text sorts
  case-insensitively.
- `review-view.ts` — pure `ReviewGrid` → view-model transform
  (`renderReviewGridView`): header cells with the active + next-click sort
  direction, body cells in column order, and a resolved **source deep-link `href`**
  per row (`/evaluations/:id/documents/:documentId?element=…&page=…&chunk=…`,
  page/chunk added only when present).
- `container.ts` — `WorkflowController.openReviewGrid({ evaluationId })` reads the
  persisted responses via `listResponses` and wraps them in a `ReviewGrid`
  (read-only; no stage transition).
- `index.ts` — public surface (`ReviewGrid`, `REVIEW_COLUMNS`,
  `renderReviewGridView` + types); `e2e/review-grid.e2e.ts` — Playwright acceptance
  spec (all columns, numeric currency sort, source deep-link, requirement filter).

**Design decisions.** (1) *Framework-free core; a dumb DOM* — the
typing/sorting/filtering + view model are pure and vitest-tested, so the exit
criterion is provable without a browser (Thread 11 posture). (2) *Currency is a
real number, proven against Wayfinder's helper* — the domain already carries
`estimateAud: number | null` (Thread 8/10), so the sort key *is* the figure (a
numeric, not lexical, sort); the exit test pins that numeric contract against
`typedDisplayCell("currency", …)` → `{ isNumeric: true }` (the read-only reuse per
§9 / ADR-0006, same as the Thread 8 adapter). Production grid code imports nothing
from Wayfinder; the assertion is test-only, so the app keeps its allowed dependency
set. (3) *Source column deep-links to the exact location* — each row carries the
womblex provenance (documentId / elementOrder / page / chunkId) resolved to a
stable href the e2e pins. (4) *A null estimate never masquerades as a figure* —
empty currency cell, non-numeric, sorts to the floor so "no figure yet" rows
cluster. (5) *Read-only open* — building the rows is Thread 10's
`BuildEvaluationTable` (`classifying → review`), already done before the grid opens.

**Exit test — PASSED.** redline-web **33/33** (was 18; +15):
`review-grid.test.ts` (8) — the exit test: typed rows, currency numeric via
`typedDisplayCell`, a currency sort ordering `[90, 100, 1000]` (not lexical),
case-insensitive stable text sort, null-estimate clustering, free-text +
requirement filters, unsortable source column; `review-view.test.ts` (5) — the
source deep-link href (`…?element=7&page=3&chunk=doc-a%3A2`, page/chunk dropped
when absent), header sort state, requirement filter, empty grid;
`container.test.ts` (+2 → 7) — `openReviewGrid` reads persisted responses (numeric
estimate, intact provenance) and opens empty when nothing was built. Full
workspace typecheck/lint/test/build green; `./validate.sh` → **11/11**.

**Known limitations.** (1) No Next.js shell yet — the grid logic is complete and
tested; the route/DOM layer + the Playwright run are the Track 4 shell follow-up
(shared with Thread 11); `e2e/review-grid.e2e.ts` pins the `/evaluations/:id/review`
DOM contract. (2) Pricing pivots are Thread 13; Excel export (Thread 14) reuses the
same numeric-currency guarantee. (3) One `productName` per evaluation (carried from
Threads 10–11). (4) No live end-to-end run (no browser/app server here) — proven
against the built `ProcurementResponse[]` in memory, the Threads 5–11 posture.

**Version bump intent:** MINOR — new app surface (review grid); no breaking changes
(pre-1.0).

**Docs:** [thread-12](./threads/thread-12-in-app-review-grid.md).

### Thread 13 log (2026-08-03) — ✅ COMPLETE

**Built** the **pricing pivots** in `apps/redline-web` (build plan §1 "Aggregate:
pricing per brand (vendor); pricing per requirement/criterion" / §7 Track 4). Same
posture as Threads 11–12: a framework-free, unit-tested core a thin Next.js/React
shell binds to (ADR-0006).

**Modules (`apps/redline-web/src/lib/`):**
- `pricing-pivot.ts` — the **pivot brain**, `PricingPivot`. Rolls the Thread 10/12
  `ProcurementResponse[]` up by `PivotAxis` (`brand` / `requirement` /
  `brand-x-requirement`) with a `sum`/`avg` measure over `estimateAud`. Mirrors
  `computePivot`'s algorithm — first-appearance distinct groups, ranked by
  descending measure total with an alphabetical tiebreak, a `sampleCount` counting
  only rows that carried a figure — over redline's own domain type. Returns
  `PricingPivotResult` (`primaryGroups`, `secondaryGroups`, `rows`, `columnTotals`,
  `grandTotal`, `hasNumericData`).
- `pricing-view.ts` — pure `PricingPivotResult` → table transform (`renderPivotView`):
  axis/measure headers, one column per secondary group for a cross-tab,
  currency-formatted display cells, and a blank (not `$0.00`) cell where a group
  carried no figure. The numeric result stays the source of truth (the XLSX export,
  Thread 14, writes the real numbers).
- `container.ts` — `WorkflowController.openPricingPivot({ evaluationId })` reads the
  persisted `ProcurementResponse[]` via `listResponses` and wraps them in a
  `PricingPivot` (read-only).
- `index.ts` — public surface (`PricingPivot`, `PIVOT_AXES`, `renderPivotView` +
  types); `e2e/pricing-pivots.e2e.ts` — Playwright acceptance spec (per-brand,
  per-requirement, brand×requirement, sum/avg toggle).

**Design decisions.** (1) *Reuse `computePivot`'s algorithm, not its types* —
Wayfinder's `computePivot` operates on its own `FieldReportSessionRow`/`PivotColumn`
analytics model (exposed from `@rbrasier/domain`, a **devDependency**); production
app code imports nothing from Wayfinder (CLAUDE.md architecture rule), so
`PricingPivot` reimplements the same deterministic shape over `ProcurementResponse[]`
and the exit test pins **parity against the real `computePivot`** in a test-only
assertion — exactly Thread 12's `typedDisplayCell` posture. (2) *Currency is a real
number end to end* — the pivot sums/averages `estimateAud: number | null` directly,
so a total *is* a number (numeric sort/export). (3) *A null estimate is a non-sample,
never a zero* — a description-fallback row is excluded from the sum, is not an average
denominator, and renders blank; an all-fallback pivot reports `hasNumericData: false`.
(4) *brand×requirement is a cross-tab with brand primary* — vendor primary (ranked),
requirement secondary; `columnTotals` sum each requirement column. (5) *Read-only
open* — pivots are a read lens on the review-stage data `BuildEvaluationTable` already
produced.

**Exit test — PASSED.** redline-web **45/45** (was 33; +12):
`pricing-pivot.test.ts` (7) — the exit test: on a five-row fixture (3 vendors × 2
requirements + one null-estimate fallback) the totals match hand-computed values
(per-brand sum Initech 3000/Globex 2000/Acme 1500, `grandTotal 6500` over 4 samples;
per-brand avg Acme 750 / Globex 2000 / Initech 3000; per-requirement residency 6000 /
support 500; brand×requirement Acme×residency 1000 / ×support 500), an all-fallback
pivot reports `hasNumericData:false` + `{ value:0, sampleCount:0 }`, and the result
agrees with Wayfinder's `computePivot` on the same data projected onto its
`FieldReportSessionRow` shape; `pricing-view.test.ts` (4) — header/label shaping,
currency formatting, the blank no-figure cell, one column per secondary group;
`container.test.ts` (+1 → 8) — `openPricingPivot` reads persisted responses and rolls
them up per brand. Full workspace typecheck/lint/test/build green; `./validate.sh` →
**11/11**.

**Known limitations.** (1) No Next.js shell yet — the pivot logic is complete and
tested; the route/DOM layer that binds to `renderPivotView` + the Playwright run are
the Track 4 shell follow-up (shared with Threads 11–12); `e2e/pricing-pivots.e2e.ts`
pins the `/evaluations/:id/pivots` DOM contract. (2) Excel export (Thread 14) writes
one sheet per pivot, reusing the numeric `PricingPivotResult` (not the display
strings). (3) No live end-to-end run (no browser/app server here) — proven against
the built `ProcurementResponse[]` in memory, the Threads 5–12 posture.

**Version bump intent:** MINOR — new app surface (pricing pivots); no breaking
changes (pre-1.0).

**Docs:** [thread-13](./threads/thread-13-pricing-pivots.md).

### Thread 14 log (2026-08-04) — ✅ COMPLETE

**Built** the **Excel export** in `apps/redline-web` (build plan §1 "in-app review
first; Excel export second" / §7 Track 4). Same posture as Threads 11–13: a
framework-free, unit-tested core — pure builders that turn the review grid +
pricing pivots into `write-excel-file` sheet data — plus a thin, lazily-loaded
browser trigger a Next.js/React shell binds to (ADR-0006).

**Modules (`apps/redline-web/src/lib/`):**
- `excel-export.ts` — the **export brain**. `buildReviewSheetData(grid,
  evaluationId)` → the review sheet (bold header of every `REVIEW_COLUMNS`
  column; numeric `Number` cells for currency/confidence; a blank `null` cell for
  a null estimate; the source column as a `hyperlink` cell to the exact document
  location). `buildPivotSheetData({ axis, measure, result })` → one pivot sheet
  (single-axis `[group, measure]` rows, or a brand×requirement cross-tab with one
  column per secondary group + a row total, then a bold column-total footer) — the
  **real `PricingPivotResult` numbers**, not the formatted strings.
  `buildEvaluationWorkbook(...)` → `{ sheets, sheetNames }`: a `Review` sheet + one
  sheet per pivot (`Pricing by Vendor` / `Pricing by Requirement` /
  `Vendor × Requirement`). `evaluationExportFileName` slugs a dated filename.
  `exportEvaluationXlsx` is the lazy browser writer — a dynamic
  `import("write-excel-file/browser")` (out of the initial bundle, exactly as
  Wayfinder's `exportInsightsXlsx`), writing an array of `{ name, data }` sheet
  objects to a `.toFile` download.
- `container.ts` — `WorkflowController.buildWorkbook({ evaluationId })` reads the
  persisted `ProcurementResponse[]` via `listResponses` and shapes them into an
  `EvaluationWorkbook` (read-only; no stage transition).
- `index.ts` — public surface; `e2e/excel-export.e2e.ts` — Playwright acceptance
  spec (the "Export to Excel" button downloads a dated `.xlsx` that opens).

`apps/redline-web/package.json` gains `write-excel-file@^4.1.1` — the same browser
xlsx writer Wayfinder uses.

**Design decisions.** (1) *Reuse Wayfinder's `write-excel-file` cell shape,
verified against its own code* — the `SheetCell` union (`{ value, type:
String\|Number, fontWeight? }` or `null`) mirrors
`apps/web/src/components/admin/field-report-export.ts` (§9); a `Number`-typed cell
is what makes currency a **real numeric Excel cell**. Per CLAUDE.md the
multi-sheet call was pinned against the library's **bundled type declarations**:
the correct form is an array of `{ name, data }` `Sheet` objects, not a
`sheets: string[]` option (the first attempt's typecheck error drove the fix).
(2) *Currency numeric end to end* — the review sheet reads the `ReviewGrid`'s
already-typed cells (Thread 12); the pivot sheets write the numeric
`PricingPivotResult.value`s (Thread 13); the exit test cross-checks against
`typedDisplayCell` (test-only reuse, production app code imports nothing from
Wayfinder). (3) *A null estimate writes a blank cell, never a 0* — the
description-fallback signal (Thread 10) surfaces as an empty `null` cell in the
review sheet and any cross-tab intersection; the costing description still writes
as text. (4) *The source column is a working hyperlink* — the same deep-link
`review-view.ts` renders in-app. (5) *One sheet for the table, one per pivot* —
the three summed pivots the plan names. (6) *Pure builders + a thin lazy writer* —
the interesting logic is vitest-tested; the untestable-here browser writer is a
one-line dynamic import, so the exit criterion is provable without a browser.
(7) *Read-only open* — `buildWorkbook` reads `listResponses` and never writes.

**Exit test — PASSED.** redline-web **58/58** (was 45; +13):
`excel-export.test.ts` (11) — the exit test: the review sheet writes
`estimateAud 1000` as `{ value: 1000, type: Number }` (cross-checked against
`typedDisplayCell("currency",…)` → `isNumeric:true`), confidence `0.86` numeric,
a null estimate as a blank `null` cell (its description still text), the source
cell as a hyperlink to
`/evaluations/eval-1/documents/doc-a?element=1&page=3&chunk=doc-a%3A2`; the pivot
sheets write real numbers (per-brand ranks Globex 2000 above Acme 1500, bold
`Total` footer 3500; the cross-tab lays out one numeric column per requirement +
a row total, a blank cell where an intersection has no figure); the workbook is a
`Review` sheet + one per pivot; `evaluationExportFileName` slugs/dates the name;
`container.test.ts` (+2 → 10) — `buildWorkbook` reads persisted responses into a
workbook with the numeric estimate + source hyperlink intact, and opens an
empty-but-headed workbook when nothing was built. Full workspace
typecheck/lint/test/build green; `./validate.sh` → **11/11**.

**Known limitations.** (1) No Next.js shell yet — the export logic is complete and
tested; the route/DOM layer that mounts the "Export to Excel" button and calls
`exportEvaluationXlsx` + the Playwright run are the Track 4 shell follow-up
(shared with Threads 11–13); `e2e/excel-export.e2e.ts` pins the export DOM
contract. (2) No live browser download here — proven at the sheet-data layer (the
mapping the writer serialises) against the built `ProcurementResponse[]` in
memory, the Threads 5–13 posture. (3) Pivots exported at `sum`; the average
toggle stays an in-app lens (Thread 13).

**Version bump intent:** MINOR — new app surface (Excel export); no breaking
changes (pre-1.0).

**Docs:** [thread-14](./threads/thread-14-excel-export.md).

### Thread 15 log (2026-08-05) — ✅ COMPLETE

**Made Isaacus-optionality explicit and proved the air-gapped path end to end**
(build plan §7 Track 5). The stub already ran without Isaacus (Thread 3); Thread 15
models the choice, proves the whole pipeline degrades cleanly with the key unset,
and surfaces the live path to the UI.

**Service — `services/womblex-ingest`:**
- `config.py` — `Settings` reads `ISAACUS_API_KEY` and exposes an `EnrichmentMode`
  (`offline` \| `isaacus`) derived from `WOMBLEX_MODE` + a non-blank key: **stub is
  always offline** (never calls Isaacus, even with a key); **real is offline unless
  a non-blank key is supplied** (womblex's own edge/offline mode). `isaacus_enabled`
  is the boolean `/health` reports.
- `main.py` — `build_app` takes `womblex_mode` + `enrichment_mode`; `GET /health`
  now reports `{ status, bucket, womblexMode, enrichmentMode, isaacusEnabled }` so a
  deployment and the UI toggle read the live path. `build_app_from_env` wires the
  derived mode.
- `README.md` — documents **both modes** (a `WOMBLEX_MODE` × `ISAACUS_API_KEY` →
  `enrichmentMode` table) + the air-gap section + the new `/health` fields.
- `scripts/thread-15-airgap.sh` — the **live** exit test (real MinIO): brings up the
  `ingest` profile with `ISAACUS_API_KEY` unset, asserts `/health` is offline, then
  `POST /ingest` → shards land → `GET /extractions/...` serves the JSON read model.

**UI config toggle — `apps/redline-web`:** `src/lib/ingest-config.ts` —
`parseIngestHealth` (narrows the `/health` JSON; null on an older/malformed body) +
`renderIngestConfigView` (extraction/enrichment labels, `airGapped`, an
`isaacusToggle` **disabled on the stub path**, so the shell never offers a switch
that can't take effect). Pure, framework-free (Threads 11–14 posture); exported from
`src/index.ts`; `e2e/ingest-config.e2e.ts` pins the settings-route DOM contract
(vitest is the gate until the Next.js shell lands).

**Design decisions.** (1) *Enrichment mode is **derived**, not a fourth env var* —
one source of truth (`WOMBLEX_MODE` + key presence) can't disagree with itself.
(2) *Isaacus stays doubly opt-in* (image `ISAACUS=1` *and* runtime key); an
air-gapped deployment sets neither. (3) *The exit criterion is proven twice* —
offline in pytest (gates in CI without a container) and live via the smoke script.
(4) *`/health` is the single surface* the deployment and the UI read; the UI
view-model is a pure transform of it. (5) *The toggle encodes the constraint* in the
tested view-model, not DOM glue.

**Exit test — PASSED.** The full pipeline runs with `ISAACUS_API_KEY` **unset**:
`tests/test_airgap_pipeline.py::test_full_pipeline_runs_air_gapped` builds the app
the way the process does at startup with the key deleted (S3 faked), `/health`
reports `offline`, then `POST /ingest` → `202 succeeded`, `_manifest` + element
shards land under `proc/airgap-1/`, `GET /extractions/airgap-1/{sourceHash}` serves
the JSON read model (elements + `chunkId "{sourceHash}:0"`) — all offline.
womblex-ingest pytest **27** (was 17; +10: `test_enrichment_mode.py` 6,
`test_airgap_pipeline.py` 2, `/health` +3); redline-web **63** (was 58; +5
`ingest-config.test.ts`). Full workspace typecheck/lint/test/build green;
`./validate.sh` → **11/11**.

**Known limitations.** (1) Real womblex still not wired — `real` mode raises
`NotImplementedError` (carried from Threads 3–4), so the Isaacus-disabled *real*
path (womblex edge mode) is proven at the wiring/health layer, not by running real
womblex. (2) No live compose run here (no container runtime) — the exit criterion is
proven offline in pytest; `scripts/thread-15-airgap.sh` is the live proof where
Podman/Docker is available. (3) No Next.js shell yet — the config view is complete
and tested; the settings route + the Playwright run are the Track 4 shell follow-up
(shared with Threads 11–14).

**Version bump intent:** MINOR — new `/health` surface + UI config view + air-gap
proof; no breaking changes (pre-1.0).

**Docs:** [thread-15](./threads/thread-15-isaacus-optional-and-air-gap.md).
