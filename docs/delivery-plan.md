# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-04 (the UI mount is
> complete — the `evaluation` tRPC router, `container-redline.ts` seam, the
> `/evaluations/:id/{review,pivots,grouping}` routes + components, the
> `evaluation:review` auth gate and the served-fork Playwright specs are all
> merged; the served surface + how it sits now live in architecture.md §3/§6,
> removed from this plan. The cold-start classifier's store (`DrizzleChunkStore`
> over `redline_chunks`) and adjudicator (`HttpAdjudicator`) adapters are now
> built too (architecture.md §3). The remaining mount pieces — a redline↔fork
> `ILanguageModel` bridge and the live `getContainer()` call — are folded into the
> corpus run below, which is what exercises them)
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
profiles — all green under `./validate.sh`), and the retrieval, pricing and
UI-mount legs are **built and merged** — see [`architecture.md`](./architecture.md)
§3/§4/§5/§6 for the store-backed classifier, the money `IFinancialExtractor` and
the served fork, and §5 below for how they were sequenced. What remains is a
single vertical: wire the live container and run a real corpus through it.

### 1 — Real corpus, end to end

First the seam the *served* UI still waits on: **wire the live `getContainer()`**
in the fork. The cold-start classifier's store (`DrizzleChunkStore` over
`redline_chunks`) and adjudicator (`HttpAdjudicator`) adapters are now **built**
(architecture.md §3), alongside the repository, extraction-reader and money
`IFinancialExtractor` adapters `container-redline.ts` already takes injected. What
remains to close the seam is a redline↔fork `ILanguageModel` bridge (redline's
`summarise(...)` over the fork's `generateObject<T>(...)` port — a real adapter,
not a pass-through) and the `getContainer()` call itself: bind the built ports and
hang `buildRedlineModule`'s controller on `ctx.container.redline`. With those
bound, the served fork shows real data end to end and the
`E2E_REDLINE_EVALUATION_ID`-gated Playwright specs run green against a real
evaluation. (The grouping route's interactive composition surface —
assign/advance over the `WorkflowManager` — is not part of this; it lands with the
lens stage machine, §3.)

Then run a real procurement corpus through: `womblex` profile ingests → the sidecar
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

Deferred until the lean vertical is complete. Revisit **after** the corpus run
(§2) has shown what the cold-start path actually gets right on a real corpus —
that evidence should shape the lens work rather than be assumed. In dependency
order:

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
   — §2).

---

## 5. Sequencing

**The lean vertical runs to completion before the deferred work starts.**

0. **The store-backed retrieval leg, the pricing leg and the UI mount are built**
   (merged 2026-08-01 → 2026-08-03). ADR-0017 and ADR-0018 (Accepted 2026-07-31)
   overturned ADR-0014 and set the store the retrieval leg is built on; the
   store-side chunk surface and the cold-start classifier over it now exist and
   are green under `./validate.sh`. They replaced the old in-TypeScript retrieval
   leg (the former `ClassifyByRetrieval` / `IEmbeddingReader` / embeddings adapter
   are superseded). The money `IFinancialExtractor` (`MoneySpanFinancialExtractor`)
   is likewise built: it sums a document's table-cell money spans over
   `IMoneySpanStore` into grid AUD, wired behind the port in `lib/container.ts`
   (architecture.md §4 step 7 / §7 item 4). The UI mount lands in the forked
   Wayfinder (`services/wayfinder`, branch `redline-integration`), not in
   `apps/redline-web` —
   [ADR-0019](./adr/0019-wayfinder-fork-submodule-for-ui-mount.adr.md): the
   `@redline/*` workspace link, the `evaluation` tRPC router, the
   `container-redline.ts` seam, the `/evaluations` routes + components, the
   `evaluation:review` auth gate and the served-fork Playwright specs are all
   merged (architecture.md §3/§6). **ADR-0018's addendum still defers vector
   *similarity search*** — the `pgvector`/ANN index and `findSimilar` — so the
   classifier runs hard rules + adjudication over exact fetch, no nearest-neighbour
   step. The store-backing sub-choice for the eventual index (`pgvector` vs ANN
   over the shards) is a follow-on ADR decided *then*, not now. The cold-start
   classifier's two production port adapters are also built (2026-08-04): the
   `DrizzleChunkStore` `IChunkStore` reader over `redline_chunks` (the TS reader
   the sidecar's write path had left unpaired) and the `HttpAdjudicator`
   `IAdjudicator` over an OpenAI-style chat/completions seam — both green under
   `./validate.sh` (architecture.md §3).
1. **The corpus run (§2)** — finish the live `getContainer()` wiring (a
   redline↔fork `ILanguageModel` bridge, then bind the built ports and hang
   `buildRedlineModule`'s controller on `ctx.container.redline`) and run a real
   corpus end to end. The point of the exercise.

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
