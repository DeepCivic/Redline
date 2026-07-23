# Procurement Evaluation Adapter — Build Plan

> A Wayfinder plugin/adapter (its own repo) for procurement evaluation, integrating
> **womblex** (document extraction) and **Numbatch** (no-code classification, extended
> with configurable financial table extraction).

_Placeholder repo name:_ **`procautomatr`** — rename freely.

---

## 1. Goal

A tabular, sortable **in-app review flow** for procurement responses, with Excel export.

**Per response, capture:**
- vendor name
- product name
- response to which requirement (fixed **1–6**)
- extra categorisation (e.g. req 1: whole-solution vs component; req 6: broad category) — the **user-defined** element
- one-paragraph product summary
- dot-point costing extract (dollar estimate if provided, else a short description of costs)
- link to document location (page / chunk provenance)

**Aggregate:**
- pricing per brand (vendor)
- pricing per user-defined category

**Priorities:** in-app review first; Excel export second.

---

## 2. Upstream tools (corrected understanding)

| Tool | What it is | Consumption |
|---|---|---|
| **womblex** | Python document-extraction pipeline. Detects doc type, extracts, chunks, optionally enriches/classifies via Isaacus. Writes **Parquet shards to S3/MinIO** (`*.elements.parquet`, `*.table_cells.parquet`, `*.form_fields.parquet`, `*.chunks.parquet`, `*._manifest.parquet`). | Run as a sidecar/worker; consume Parquet output (or a JSON wrapper) from object storage. Has non-Isaacus modes (edge/offline). |
| **Numbatch** | Python no-code multi-topic classifier (FastAPI + SvelteKit + Arq + LoRA). Ingests womblex chunk Parquet, trains classifiers, batch inference with **document roll-ups** + review/correct loop. | Standalone stack with a FastAPI/OpenAPI surface. **Forked & extended** here for financial table extraction. |

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
procautomatr/
├── services/
│   ├── womblex-ingest/          # womblex sidecar; Isaacus optional (flag)
│   └── numbatch/                # Numbatch stack, FORKED + EXTENDED (financial extraction)
├── packages/
│   ├── proc-domain/             # entities + ports (zero deps, Result pattern)
│   ├── proc-application/        # use-cases (imports proc-domain + @rbrasier/domain types)
│   ├── proc-adapters/           # Parquet/JSON reader, Numbatch client, repositories
│   └── proc-shared/             # zod schemas shared with the UI
├── apps/
│   └── proc-web/                # specialist control surface + review grid
└── infra/
    └── docker-compose.yml       # womblex + numbatch + postgres + minio (compose profiles)
```

- All new tables use a **`proc_` prefix** in a **separate Postgres schema/DB**.
- Result pattern at all boundaries; tests-first; mirror Wayfinder's code-writing rules.

---

## 5. Core data model

```typescript
// proc-domain/src/entities/procurement-response.ts
export interface ProcurementResponse {
  evaluationId: string;
  vendorName: string;                        // "brand"
  productName: string;
  requirementNumber: 1 | 2 | 3 | 4 | 5 | 6;  // fixed — from Numbatch profile
  categorisation: {
    solutionScope?: "whole_solution" | "component";  // e.g. requirement 1
    userDefinedCategory?: string;                     // e.g. requirement 6 — Numbatch user topic
  };
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

### Workflow manager model (one response ≠ one document)

Relationships are many-to-many: 1 vendor→N docs→1 response; N vendors→1 response (consortium);
1 vendor→N responses (multiple offerings).

```typescript
// proc-domain/src/entities/evaluation-structure.ts
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
  | "classifying"          // Numbatch: requirements 1–6 + categories + financials
  | "review"               // the tabular review grid
  | "finalised";
```

The control surface lets the specialist drag documents into response groups, mark consortiums,
split a vendor's multiple bids, and (re)run classification per group.

---

## 6. Numbatch extension — configurable financial table extraction aligned to topics

Numbatch today: chunk → topic classification → document roll-up. We add:

- **`financial_profile`** (new concept): per topic (or profile), a config declaring what monetary
  facts to pull (unit price, total, recurring vs one-off, currency, line-item vs bundle) and how to normalise.
- **New Arq worker stage:** reads womblex `table_cells` / `sheet_cell` / `form_fields` (currency-typed)
  for the chunks a topic matched; extracts figures or a **description fallback**; writes
  `financial_extractions` (per `source_doc_id`, per topic, with provenance to `elem_order`).
- Directly serves the "dollar estimate **or** short description" requirement.

This is the largest net-new engineering item; a **fork of Numbatch is implied**.

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
- **Thread 2 — `proc-domain` core entities & ports.** `Vendor`, `ResponseGroup`, `IntakeStage`,
  `ProcurementResponse`, `ProcurementRequirement` (fixed 1–6 + user-defined categories); ports:
  `IProcurementExtractionReader`, `IProcurementClassifier`, `IFinancialExtractor`, `IEvaluationRepository`.
  Zero deps, Result pattern, tests-first. _Exit: domain builds; entity invariants covered._

### Track 1 — Ingestion (womblex)
- **Thread 3 — womblex sidecar service.** `services/womblex-ingest`: Dockerfile installing womblex
  (Isaacus behind opt-in build arg/flag); HTTP/MCP wrapper `ingest(documents) → run_id`,
  `status(run_id)`; writes Parquet to MinIO under `proc/{evaluationId}/`.
  _Exit: compose up, POST docs, shards land in MinIO._
- **Thread 4 — Extraction reader adapter (Parquet→JSON boundary).** Decide + implement boundary:
  sidecar emits **JSON** (recommended — keeps TS free of Parquet) or a Parquet-reading TS adapter.
  Implement `IProcurementExtractionReader` (elements/table-cells/chunks + provenance).
  _Exit: adapter reads a real run into typed objects; contract test against fixture._

### Track 2 — Classification & financials (Numbatch)
- **Thread 5 — Numbatch as-is integration.** `services/numbatch` in compose; `NumbatchClassifier`
  adapter (HTTP/OpenAPI) implementing `IProcurementClassifier`: fixed 6-requirement profile;
  batch inference over a group's chunks; read roll-ups.
  _Exit: ingested chunks → requirement 1–6 classifications per document._
- **Thread 6 — Numbatch extension: `financial_profile` schema & config API.** New tables
  (`financial_profiles`, `financial_extractions`), Alembic migration, config endpoints. Schema only.
  _Exit: create a financial profile for a topic via API; migration passes CI._
- **Thread 7 — Numbatch extension: financial extraction worker.** Arq stage reads womblex
  table cells for matched chunks; extracts currency-normalised figures or description fallback;
  writes `financial_extractions` with provenance.
  _Exit: synthetic tender workbook → figures + provenance in DB; unit + integration tests._
- **Thread 8 — `IFinancialExtractor` adapter.** `proc-adapters` client pulling `financial_extractions`
  into `ProcurementResponse.costing` (`estimateAud: number | null` + `description`).
  _Exit: contract test; currency numeric via `typedDisplayCell`._

### Track 3 — Persistence & orchestration
- **Thread 9 — `proc_` persistence layer.** Drizzle schema + repositories (evaluations, vendors,
  response groups, responses); separate Postgres DB/schema; migrations.
  _Exit: repositories round-trip; migration idempotent._
- **Thread 10 — Orchestration use-cases (`proc-application`).** `IngestDocuments`,
  `AssignDocumentsToGroups`, `ClassifyResponseGroup`, `ExtractFinancials`, `BuildEvaluationTable`.
  One-paragraph AI summary via an `ILanguageModel`-shaped port.
  _Exit: use-case tests with mocked ports produce a full `ProcurementResponse[]`._

### Track 4 — Control surface & review (apps/proc-web)
- **Thread 11 — Workflow manager UI (specialist control surface).** Drag docs → response groups;
  mark consortium; split multi-bid vendors; drive `IntakeStage`; trigger (re)classification per group.
  _Exit: specialist can compose the three relationship shapes and advance stages._
- **Thread 12 — In-app review grid (priority 1).** Sortable/filterable table reusing
  `field-report-view` typed cells; source column deep-links to document location; all required columns.
  _Exit: real evaluation renders; currency sorts numerically; source links resolve._
- **Thread 13 — Pricing pivots.** Reuse `computePivot` for per-brand and per-user-defined-category
  rollups (sum/avg of `estimateAud`); axis selection (brand, category, brand×category).
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
2. **Parquet boundary (Thread 4)** — _open_ — womblex sidecar emits **JSON** (recommended) vs a Parquet-reading TS adapter. Decide in Thread 4.
3. **Numbatch coupling** — _open, fork implied_ — fork into `services/numbatch` (required for the financial extension, Threads 6–7)
   vs run upstream + thin extension service. Confirm before Thread 5.
4. **Shared vs separate MinIO/Postgres** — _open_ — share Wayfinder's MinIO bucket & Postgres (different prefix/schema)
   vs stand up its own? Decide before Thread 3 / Thread 9.
5. **Auth/roles** — _open_ — does the review surface reuse Wayfinder auth/roles, or its own? Decide before Thread 11.

> **ADR model adopted.** This repo now follows Wayfinder's ADR format under
> [`docs/adr/`](./adr/README.md). Decisions 2–5 will each get their own ADR when locked.

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
| 2 — proc-domain core entities & ports | 🟡 next | |
| 3 — womblex sidecar service | ⚪ not started | |
| 4 — Extraction reader adapter | ⚪ not started | |
| 5 — Numbatch as-is integration | ⚪ not started | |
| 6 — Numbatch financial_profile schema & API | ⚪ not started | |
| 7 — Numbatch financial extraction worker | ⚪ not started | |
| 8 — IFinancialExtractor adapter | ⚪ not started | |
| 9 — proc_ persistence layer | ⚪ not started | |
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

**Scaffolded** (`procautomatr/`):
- Root: `package.json` (turbo scripts scoped `--filter=@procautomatr/*`), `pnpm-workspace.yaml`
  (incl. `vendor/wayfinder/packages/*`), `turbo.json`, `tsconfig.base.json`, `tsconfig.json`,
  `.prettierrc`, `eslint.config.mjs` (domain = relative-imports-only; `vendor/**` ignored),
  `.gitignore`, `.gitmodules`, `README.md`.
- `packages/proc-domain/` — zero-dep `Result`/`DomainError` primitives, `index.ts`, and the
  **consumption spike test** `src/wayfinder-spike.test.ts` importing `typedDisplayCell` /
  `typedCellValue` from `@rbrasier/domain`.
- `packages/proc-shared`, `packages/proc-application`, `packages/proc-adapters` — package.json
  (`test` = `vitest run --passWithNoTests`) + tsconfig + placeholder `index.ts`.
- `apps/README.md`, `services/README.md` — placeholders for later threads.
- `docs/adr/README.md` + `docs/adr/0001-adapter-over-wayfinder.adr.md` — **Wayfinder ADR model adopted.**
- `scripts/podman-run.sh` — reproducible Node-20-in-Podman harness (host had no local node).

**Exit test — PASSED.** Run in `docker.io/library/node:20-bookworm-slim` via Podman
(`flatpak-spawn --host`), pnpm 9.12.0:
- `pnpm install` → clean (168 pkgs; `@rbrasier/domain` resolved as a workspace dep).
- `pnpm build` → **4 successful / 4 total**.
- `pnpm test` → **7 successful / 7 total**; `proc-domain` spike **3/3 passed**
  (`typedDisplayCell("currency", "1200.50")` → `{ value: 1200.5, isNumeric: true }`).
- `pnpm typecheck` → **7 successful / 7 total**.

**Delineation approach (decision #2 of this session).** Instead of an on-disk submodule/symlink,
Wayfinder's **source is vendored into a throwaway scratch copy** at `vendor/wayfinder` *only inside
the container* by `scripts/podman-run.sh` — currently just `packages/domain` (zero-dep). The
committed `procautomatr` tree never contains Wayfinder, and the real Wayfinder tree is never
written to. This keeps a hard boundary while `@rbrasier/*` still resolves as workspace packages.
`WAYFINDER_PACKAGES` env var widens the vendored set when later threads need `shared`/`adapters`.

**Publishing target (decision #3 of this session).** Remote will be the **DeepCivic** org
(not johntooth). `.gitmodules` url points at DeepCivic; set the actual git remote at `git init` time.

**Remaining setup (not blocking Thread 1's exit test, needed for real git workflow):**
1. `git init` `procautomatr` and add the DeepCivic remote.
2. Wire `vendor/wayfinder` for local (non-Podman) dev — submodule against the DeepCivic Wayfinder
   mirror, or a symlink to a sibling checkout.
