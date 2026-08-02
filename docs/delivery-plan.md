# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-03 (UI mount steps
> 1–3 done — the `evaluation` tRPC router, `container-redline.ts` seam and the
> `/evaluations/:id/{review,pivots,grouping}` routes + components are merged;
> the served surface + design are now in architecture.md §3/§6; removed from the
> plan. Item 1's auth gate (`evaluation:review` on `reviewProcedure`) and the
> Playwright specs pointed at the served fork are now done too — item 1 is
> complete bar the live `getContainer()` wiring, which lands with item 2)
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
The pricing leg is likewise built: the money `IFinancialExtractor`
(`MoneySpanFinancialExtractor`) sums a document's table-cell money spans into
grid AUD, wired behind the port in `lib/container.ts` (2026-08-02;
`architecture.md` §4 step 7 / §7 item 4). See
[`architecture.md`](./architecture.md) §4/§5/§7 for how they sit in the
dataflow. What remains, in order:

### 1 — Mount the review UI into the forked Wayfinder

**The only genuinely missing piece.** The review grid, pricing pivots, Excel
export and control surface are built as framework-free brains + pure view models
in `apps/redline-web/src/lib/`, and the fork now *serves* the read-side surface:
per [ADR-0019](./adr/0019-wayfinder-fork-submodule-for-ui-mount.adr.md) the mount
lives in the `services/wayfinder` submodule (branch `redline-integration`) inside
Wayfinder's chrome/auth/router. The `@redline/*` workspace link, the `evaluation`
tRPC router (read-side `reviewGrid`/`pricingPivot`/`workbook`), the
`container-redline.ts` seam (`buildRedlineModule` → `WorkflowController`) and the
`/evaluations/:id/{review,pivots,grouping}` routes + `"use client"` components
are **built, tested and merged** — see [`architecture.md`](./architecture.md)
§3/§6 for how they sit. The fork's `main` stays a clean upstream mirror (guarded
by `validate.sh` #15).

What remains, on the fork's `redline-integration` branch: nothing but the live
`getContainer()` wiring below — both integration steps are done.

1. **Auth — done (2026-08-02).** Reuses Wayfinder's Better Auth session; an
   `evaluation:review` permission key was added on the fork branch (ADR-0006) and
   `reviewProcedure = permissionProcedure("evaluation:review")` now gates every
   `evaluation` procedure (`reviewGrid`/`pricingPivot`/`workbook`), replacing the
   placeholder `authenticatedProcedure` gate — admins pass via the wildcard, Power
   Users hold the key by default, an unauthenticated caller is rejected upstream.
   This was the one genuine integration point ADR-0006 flagged as only resolving
   when the mount + Wayfinder run together.
2. **Playwright — done (2026-08-03).** The acceptance specs now live in the fork
   beside Wayfinder's own suite (`services/wayfinder/apps/web/e2e/redline-*.spec.ts`),
   import the fork's console-capture + AI-mock base fixture, and run against the
   served `/evaluations/:id/{review,pivots,grouping}` routes with the shared admin
   session. Selectors bind to the served DOM (`review-table`/`review-row`/
   `review-source-link`, `pivot-table`/`pivot-row`, the `Pivot axis`/`Pivot measure`
   controls); the grouping spec pins only the served landing + its navigation, since
   the interactive composition surface is deferred to the lens stage machine (§3).
   They gate on `E2E_REDLINE_EVALUATION_ID` and skip otherwise — matching the fork's
   other seed-gated phase specs — because a real redline evaluation only exists once
   the live `getContainer()` is wired (item 2). This closes the `/e2e` deviation in
   `CLAUDE.md`. The framework-free vitest suite under `apps/redline-web/` stays the
   proof of the brains + view models the served DOM binds to.

> The *served* UI does not show real data end to end until the live
> `getContainer()` is wired — principally the cold-start classifier's
> store/adjudicator adapters and a redline↔fork `ILanguageModel` bridge, the ports
> `container-redline.ts` left injected (the repository, extraction reader and money
> `IFinancialExtractor` adapters exist). Those adapters land with item 2's live
> run; the grouping route's interactive composition surface (assign/advance over
> the `WorkflowManager`) lands with the lens stage machine (§3).

_Exit (met): the Playwright specs run green-or-skip against the served fork —
with `E2E_REDLINE_EVALUATION_ID` set (a real evaluation, once the live
`getContainer()` is wired) a specialist opens `/evaluations/:id/review` inside
Wayfinder and sees the grid, pivots and export; without it the specs skip cleanly.
The remaining `getContainer()` wiring lands with item 2._

### 2 — Real corpus, end to end

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

Deferred until the lean vertical is complete. Revisit **after** item 2 has shown
what the cold-start path actually gets right on a real corpus — that evidence
should shape the lens work rather than be assumed. In dependency order:

| Item | Package(s) | Notes |
|---|---|---|
| Collision selection, ordering & capping | domain | Bounded, deterministic selection of genuinely ambiguous documents. |
| `BoundaryDecision` entity | domain | Net-new modelling. Owns "primary/secondary semantics" (see §4 item 1). |
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

1. **Open questions still owned here** (from the retired lens design): tenancy
   mapping — Numbatch `organisation_id` ↔ Wayfinder identity (needs an ADR before
   a lens is shared between users); primary/secondary semantics (net-new
   modelling — Numbatch returns score-sorted ≤3 topics with no primary/secondary
   distinction; owned by the `BoundaryDecision` item in §3); ambiguity thresholds
   (the signal register needs initial values, unmeasured until a real corpus runs
   — item 2).

---

## 5. Sequencing

**The lean vertical runs to completion before the deferred work starts.**

0. **The store-backed retrieval leg and the pricing leg are built** (merged
   2026-08-01 / 2026-08-02). ADR-0017 and ADR-0018 (Accepted 2026-07-31)
   overturned ADR-0014 and set the store the retrieval leg is built on; the
   store-side chunk surface and the cold-start classifier over it now exist and
   are green under `./validate.sh`. They replaced the old in-TypeScript retrieval
   leg (the former `ClassifyByRetrieval` / `IEmbeddingReader` / embeddings adapter
   are superseded). The money `IFinancialExtractor` (`MoneySpanFinancialExtractor`)
   is likewise built: it sums a document's table-cell money spans over
   `IMoneySpanStore` into grid AUD, wired behind the port in `lib/container.ts`
   (architecture.md §4 step 7 / §7 item 4). **ADR-0018's addendum still defers
   vector *similarity search*** — the `pgvector`/ANN index and `findSimilar` — so
   the classifier runs hard rules + adjudication over exact fetch, no
   nearest-neighbour step. The store-backing sub-choice for the eventual index
   (`pgvector` vs ANN over the shards) is a follow-on ADR decided *then*, not now.
1. **Item 1** — the mount. The reason the product cannot be looked at today. It
   lands in the forked Wayfinder (`services/wayfinder`, branch
   `redline-integration`), not in `apps/redline-web` —
   [ADR-0019](./adr/0019-wayfinder-fork-submodule-for-ui-mount.adr.md). The
   workspace link, `evaluation` tRPC router, `container-redline.ts` seam, the
   `/evaluations` routes + components, the `evaluation:review` auth gate and the
   Playwright specs pointed at the served fork are all merged (architecture.md
   §3/§6), so what remains of item 1 is only the live `getContainer()` wiring —
   which waits on item 2's adapters.
2. **Item 2** — the real corpus run. The point of the exercise.

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
