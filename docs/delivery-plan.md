# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-02 (money-stage
> invocation done — migrated to architecture.md §2/§4/§7; removed from the plan)
>
> **This tracks outstanding work only. It does not restate design.**
> [`architecture.md`](./architecture.md) is the single source of truth for *what
> redline is and how data moves through it*; [`adr/`](./adr/) holds the decisions;
> [`design-principles.md`](./design-principles.md) holds the durable adopted
> principles and non-goals. This file holds *what is left to do* and nothing else.
> Completed work and the reasoning behind superseded plans live in git history.
>
> Item numbers here are local to this document and are renumbered whenever the
> outstanding set changes; they carry no history and never need to line up with
> anything in the code or the ADRs.

---

## 1. The build-step contract

- One build step including its test. If the exit test needs two unrelated things
  built first, it is two steps.
- One agent, one context. One commit. A PR only on explicit request.
- Tests-first: the test file is written before the implementation file.
- One package where possible.

---

## 2. The lean vertical (current priority)

**Goal: a real procurement corpus goes in, and the results come out on screen,
delineated by topic and brand.** Nothing else. The comprehension-lens work and
the trained-classifier overlay are **deferred** (§3) — they are a second-order
improvement on a product that does not yet render.

**Numbatch is not on this path.** Classification runs cold-start over womblex
extraction ([ADR-0008](./adr/0008-trained-classifier-is-an-optional-overlay.adr.md)'s
first pass — no samples, no training, no adapter): hard rules + LLM adjudication
navigating the store's chunks/provenance, with the nearest-neighbour step deferred
(ADR-0018 addendum). Pricing comes from womblex's own currency-typed table cells /
money sidecars. The Numbatch stack re-enters only when a *trained* overlay or the
financial extension's roll-up is wanted; neither is needed to see the grid.

Most of this slice already exists (use-cases, adapters, web core, the compose
profiles — all green under `./validate.sh`). The retrieval leg has now been
rebuilt on a store: ADR-0017/0018 (**Accepted** 2026-07-31) superseded the
in-TypeScript vector path, and both halves — the store-side chunk surface that
materialises womblex's chunks + embeddings into `redline_`, and the cold-start
`IProcurementClassifier` over it — are **built, tested and merged** (2026-08-01).
See [`architecture.md`](./architecture.md) §4/§5 for how they sit in the dataflow.
What remains, in order:

### 1 — Currency from table cells, no Numbatch

An `IFinancialExtractor` backed by the money data, mapped to (document,
requirement) via the classification's `sourceChunkId`. Cruder than the Numbatch
financial extension and explicitly a first pass; `architecture.md` §7 item 4 notes
the money-sidecar source is the interim one and the Numbatch extension the
better long-term one. One adapter, and it removes a whole
stack from the critical path.

Read `*.money_spans.parquet` (`locus='table_cell'`, joined on
`(source_hash, parent_elem_order, row, col)`) rather than deriving `isCurrency` at
the seam. The money-stage invocation that lands those sidecars is **built**
(`services/womblex-ingest/.../money_stage.py`, the `money` compose profile;
`architecture.md` §4 step 2'). The exit test gains a real `Decimal` and an
explicit currency, and must cover a **header-evidenced bare-number column** — the
~98.7% case redline is blind to today. Supersedes
[ADR-0016](./adr/0016-currency-is-derived-from-the-verbatim-cell-value.adr.md);
decide there whether `derive_is_currency` is retained as a fallback for shards
with no money sidecar.

> **One upstream limitation to carry into the exit test, because no config can
> fix it.** `classify_column` checks vetoes *before* money terms and returns
> early (`money_columns.py:340-344`); the only escape is the header declaring its
> own currency. `rate` is a built-in veto term, and `extra_header_terms` is
> consulted too late to rescue a vetoed column. So `Hourly Rate ($)` classifies
> as money (via `header_currency`) but a bare **`Hourly Rate` / `Day Rate` column
> yields nothing** — a common tender pricing shape. `extra_veto_terms` only adds;
> nothing removes a built-in. If the real corpus hits this, it is an upstream
> change request, not a redline fix.
>
> **The `money:` section in `infra/womblex/redline.yaml` is already written**, and
> its vocabulary was exercised against upstream's real `classify_column`. Every
> term in it is load-bearing — with stock womblex vocabulary, `Subtotal`,
> `Extended`, `RRP`, `Freight` and `Disbursements` columns yield **nothing**
> (header matching is whole-token, so the built-in `total` does not cover
> `subtotal`), while `Cost Centre`, `Payment Terms`, `Value Weighting` and
> `Price Band` are promoted to **money** and would be summed into the pivots as
> prices. The five vetoes exist for that second failure — headers carrying money
> vocabulary that are not money — and each still yields to a header declaring its
> own currency, so `Warranty ($)` survives. Treat the lists as **provisional**
> and tune them against `*.money_columns.parquet` on the first real corpus
> (item 3).

_Exit: the review grid shows numeric AUD for a real tender's priced rows; the
per-brand pivot totals them._

### 2 — Mount the review UI into the forked Wayfinder

**The only genuinely missing piece.** The review grid, pricing pivots, Excel
export and control surface are all built as framework-free brains + pure view
models in `apps/redline-web/src/lib/` (green under `./validate.sh`); what is
missing is the thing that *serves* them inside Wayfinder's UI.

Per [ADR-0019](./adr/0019-wayfinder-fork-submodule-for-ui-mount.adr.md)
(**Accepted** 2026-08-01), this is **not** a standalone Next.js shell in
`apps/redline-web`. It mounts into a **forked Wayfinder** carried as the
`services/wayfinder` submodule (branch `redline-integration`), so the review UI
sits *inside* Wayfinder's chrome, auth and router — modelled 1:1 on Wayfinder's
own `extraction` feature (`apps/web/.../extraction/*`, `server/routers/extraction.ts`,
`lib/container-extraction.ts`). The mount lives in the fork, never in redline's
tree and never in upstream `main`; the fork's `main` stays a clean upstream
mirror for later upstreaming (guarded by `validate.sh` #15).

**Foundation done (2026-08-01):** commit `966361b` — `wayfinder.pin` → 0.20.0;
the fork added as `services/wayfinder`; static guards (#9 size, ruff, eslint)
exclude it; new fork-hygiene guard #15; ADR-0019 Accepted (amends 0006's
delivery vehicle, narrows 0001's "never a fork"). **Step 1 done** (commit
`a8bca49` on the fork's `redline-integration`, gitlink bumped in `11b18b7`):
the fork's `apps/web` resolves the four `@redline/*` packages via
`../../apps/*` + `../../packages/*` workspace globs — the reversible local
reference ADR-0019 called for — with a resolution test standing as its exit.
Both suites green (redline **15/15**, fork **20/20**). Recorded in
[`architecture.md`](./architecture.md) §3/§6.

The stitching build that remains, all on the fork's `redline-integration`
branch, in order:
1. **`evaluation` tRPC router** — **done** (commit `79bc493`): read-side
   `reviewGrid` / `pricingPivot` / `workbook` procedures over
   `WorkflowController.openReviewGrid / openPricingPivot / buildWorkbook`,
   returning the existing `renderReviewGridView` / `renderPivotView` /
   `EvaluationWorkbook` view models; registered as `evaluation` in the fork's
   `router.ts`. Binds the controller via `ctx.container.redline.workflowController`
   — the seam step 2 populates. Both suites green (redline **15/15**, fork
   **20/20**).
2. **`container-redline.ts`** — **done** (commit `2246be1`): `buildRedlineModule`
   composes redline's `WorkflowController` (via `buildContainer`) and returns it
   for the fork's container to expose as `ctx.container.redline.workflowController`
   — the seam step 1's router reads — mirroring `container-extraction.ts`. Per
   **Option A**, the controller's six ports cross the module boundary as
   *injected* dependencies: the `IEvaluationRepository` and
   `IProcurementExtractionReader` adapters exist, but the cold-start classifier's
   `IChunkStore`/`IAdjudicator`, the money `IFinancialExtractor` (item 1) and a
   redline↔fork `ILanguageModel` bridge are **not yet built**, so the module
   constructs no port itself (no invention, no dead code). Its vitest exercises
   the module against in-memory ports; the live `getContainer()` wiring — the
   one-line `buildRedlineModule(…)` call — waits on those adapters (items 1/3).
   Fork suite green (**14/14** across the redline-mount surface: this module +
   step 1 link + step 2 router).
3. **Routes + `"use client"` components** at `/evaluations/:id/{grouping,review,pivots}`
   (incl. Export to Excel), mirroring `run-results.tsx` / `synthesise/`. No new
   logic — they render the built view models. This and the live `getContainer()`
   wiring both need the injected ports step 2 stubbed — principally item 1's money
   `IFinancialExtractor` and the cold-start store/adjudicator adapters — before
   the served UI shows real data end to end.
4. **Auth** — reuse Wayfinder's `viewProcedure` / Better Auth session; add an
   `evaluation:review` permission key on the fork branch (ADR-0006). Swaps the
   router's placeholder `authenticatedProcedure` gate.
5. **Playwright** — point the existing specs (`apps/redline-web/e2e/`) at the
   served fork, closing the `/e2e` deviation in `CLAUDE.md`.

> One genuine integration point remains, not glue: the **live Better Auth
> session** (step 4, which ADR-0006 flagged only resolves when the shell +
> Wayfinder run together). The cross-workspace link and the container seam (both
> now done) were the other two. The rest is `extraction` one type over — plus
> populating `container-redline.ts`'s injected ports once item 1 lands its
> adapter.

_Exit: Playwright green against the served fork — a specialist opens
`/evaluations/:id/review` inside Wayfinder and sees the grid, pivots and export._

### 3 — Real corpus, end to end

Run a real procurement corpus through: `womblex` profile ingests → the sidecar
extracts, chunks and embeds (see the runbook note below) → chunk rows and
embeddings (as retrievable data) materialise into the `redline_` store (the
store-load path, built) → group documents by vendor → cold-start classify over
the store (hard rules + adjudication over exact fetch, no nearest-neighbour step
yet — built) → render. Extraction provenance still serves as JSON (ADR-0003/0017);
bulk vectors are loaded into the store as data but not yet ANN-indexed (ADR-0018
addendum). Needs `ISAACUS_API_KEY` (the embed stage is Isaacus-gated — see below)
and a corpus in the git-ignored `services/womblex-ingest/tests/corpus-local/`. The
enrich graph is **off in redline's profile** (`enrichment.enabled: false`);
enabling it — if the graph is wanted for navigation — is a config + Isaacus-cost
decision, not an assumed default, and would extend the store-load path to carry
graph edges too.

Also the owner of one open item: **measure the three OCR-table gates**
(paddleocr-only, deskew refusal, precision refusal) on the real corpus.

> **Upstream-behaviour facts to bake into the runbook (not obvious from config).**
> (a) `womblex run` writes `elements`/`table_cells`/`form_fields` but **does not
> persist chunks** — chunking and embedding are separate per-stage commands
> (`womblex chunk --shards` then `womblex embed --shards`) over the run's shard
> dir. (b) **A gating contradiction to resolve on the real run:** a live 0.3.0 run
> showed `chunk` *skipping* without `ISAACUS_API_KEY` (recorded in
> `architecture.md` §7), yet the engine's own config comments
> (`services/womblex/configs/example.yaml`, `infra/womblex/redline.yaml`) state the
> Kanon-2 *tokeniser* is free on Hugging Face and plain token chunking needs **no**
> key — only AI chunking (`chunking_model`) calls the API. These disagree; the
> real-corpus run is the place to settle whether `chunk` is truly Isaacus-gated in
> 0.3.0 or the skip had another cause, and correct `architecture.md` §7 to match.
> (c) The **embed** stage is unambiguously Isaacus-gated (`kanon-2-embedder`), and
> **`enrich`/`linking` are disabled** in redline's profile (so no graph is produced
> unless turned on).

_Exit: a specialist opens the review grid for a real tender and sees each
document delineated by topic and brand, with provenance back to source._

---

## 3. Deferred — comprehension lens & release

Deferred until the lean vertical is complete. Revisit **after** item 3 has shown
what the cold-start path actually gets right on a real corpus — that evidence
should shape the lens work rather than be assumed. In dependency order:

| Item | Package(s) | Notes |
|---|---|---|
| Collision selection, ordering & capping | domain | Bounded, deterministic selection of genuinely ambiguous documents. |
| `BoundaryDecision` entity | domain | Net-new modelling. Owns "primary/secondary semantics" (see §4 item 2). |
| Decision persistence + corrections push | adapters | Shrunk: upstream owns corrections + audit — an adapter call over an existing API, not a build. |
| Lens persistence | adapters | `redline_` tables for the lens + its Numbatch bindings (references, not copies). |
| Lens portability | application | Apply a saved lens to a different corpus; its boundary decisions still bite. |
| Lens stage machine | redline-web | Define → map → resolve → save, its own machine. |
| Collision resolution surface | redline-web | View model + controller for resolving a collision set. |
| Sample accrual | adapters | Shrunk: upstream topic-scoped dedupe indexes give re-push idempotence for free. |
| Train/activate policy | adapters | Needs redesign — auto-activation contradicts upstream ADR-0021 (activation is a user-controlled pointer move with a replay diff). Surface the upstream flow: auto-*train* on crossing the floor, then let the specialist activate. |
| Workspace extraction & release prep | workspace | Standalone workspace; sever the vendoring seam; graft the financial overlay onto the fork. Last by nature. |

---

## 4. Carried-forward items

1. **The skill layer points at deleted paths.** `.claude/CLAUDE.md` and all five
   `.claude/commands/*.md` reference `docs/comprehension-lens-design.md`,
   `docs/procurement-evaluation-plan.md` and `docs/threads/` — none of which
   exist. Every code-writing skill fails at its first instruction. They also
   encode a thread-doc lifecycle that `architecture.md` abolished, so this is a
   rewrite against the live documents, not a path fix.
2. **Open questions still owned here** (from the retired lens design): tenancy
   mapping — Numbatch `organisation_id` ↔ Wayfinder identity (needs an ADR before
   a lens is shared between users); primary/secondary semantics (net-new
   modelling — Numbatch returns score-sorted ≤3 topics with no primary/secondary
   distinction; owned by the `BoundaryDecision` item in §3); ambiguity thresholds
   (the signal register needs initial values, unmeasured until a real corpus runs
   — item 3).

---

## 5. Sequencing

**The lean vertical runs to completion before the deferred work starts.**

0. **The store-backed retrieval leg is built** (merged 2026-08-01). ADR-0017 and
   ADR-0018 (Accepted 2026-07-31) overturned ADR-0014 and set the store the
   retrieval leg is built on; the store-side chunk surface and the cold-start
   classifier over it now exist and are green under `./validate.sh`. They replaced
   the old in-TypeScript retrieval leg (the former `ClassifyByRetrieval` /
   `IEmbeddingReader` / embeddings adapter are superseded). **ADR-0018's addendum
   still defers vector *similarity search*** — the `pgvector`/ANN index and
   `findSimilar` — so the classifier runs hard rules + adjudication over exact
   fetch, no nearest-neighbour step. The store-backing sub-choice for the eventual
   index (`pgvector` vs ANN over the shards) is a follow-on ADR decided *then*, not
   now.
1. **Items 1 and 2 are independent** of each other. Classification without Numbatch
   is already done (item 0), and the money-stage invocation that lands the pricing
   sidecars is built (architecture.md §4 step 2'), so **item 1** (pricing without
   Numbatch) has the sidecars it reads and **item 2** (the UI mount) can proceed in
   parallel.
2. **Item 2** — the mount. The only genuinely new *frontend* code, and the only
   reason the product cannot be looked at today. It lands in the forked Wayfinder
   (`services/wayfinder`, branch `redline-integration`), not in `apps/redline-web`
   — [ADR-0019](./adr/0019-wayfinder-fork-submodule-for-ui-mount.adr.md); the
   foundation (submodule + guards, `966361b`), the `@redline/*` workspace link
   (step 1, `a8bca49` / `11b18b7`), the `evaluation` tRPC router (step 2,
   `79bc493`) and the `container-redline.ts` seam (step 3, `2246be1`) are merged,
   so what remains is the live container wiring, routes, auth and Playwright.
3. **Item 3** — the real corpus run. The point of the exercise.

Then, and only then: the deferred lens work (§3) in dependency order, and finally
workspace extraction and release.

### What the lean vertical deliberately does not do

- **No trained classifier, no samples, no adapter.** ADR-0008's first pass only.
- **No Numbatch stack.** Re-enters when a trained overlay or the financial
  extension's roll-up is wanted.
- **No comprehension lens.** Collisions, boundary decisions, lens persistence and
  portability all wait.
- **No vector *similarity search*.** The `pgvector`/ANN *index*, `findSimilar` and
  the store-side query-embed path are deferred (ADR-0018 addendum). The embeddings
  *are* loaded and available in the store; what waits is the nearest-neighbour index
  over the vectors. The untrained first pass runs on hard rules + adjudication over
  exact fetch without nearest-neighbour placing until a release needs it.
- **No enrich graph by default.** ADR-0017 names it as the eventual navigation
  mechanic, but redline's womblex profile disables `enrichment`/`linking`; producing
  and loading the graph is an explicit, Isaacus-costed opt-in, not part of the lean
  vertical unless chosen — and would extend the built store-load path to carry
  graph edges.
- **No workspace extraction.** Ship-shape is a later concern than see-shape.
