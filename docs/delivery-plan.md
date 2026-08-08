# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-08
>
> **This tracks outstanding work only. It does not restate design.**
> [`architecture.md`](./architecture.md) is what redline *is*;
> [`design-principles.md`](./design-principles.md) holds the durable principles
> and non-goals. Completed work and the reasoning behind superseded plans live in
> git history, not here. Item numbers are local to this file and are renumbered
> whenever the outstanding set changes.
>
> **Nothing here has been run against live services.** The wiring and the write
> path typecheck and are unit-tested; no Postgres, sidecar or adjudicator has
> ever been behind either. Expect config-level breakage on first boot, and treat
> the corpus run (§2 item 4) as the first real proof rather than a formality.
>
> **One open decision carried in the code.** `redline_topics.id` is a plain
> primary key, so a topic belongs to exactly one lens and a second lens reusing
> an id fails. Fine for now; revisit when lens portability (§3) lands.

---

## 1. The build-step contract

- One build step including its test. If the exit test needs two unrelated things
  built first, it is two steps.
- One agent, one context. One commit. A PR only on explicit request.
- Tests-first: the test file is written before the implementation file.
- One package where possible.
- **A fork-side step is two commits, not one.** Work in `services/wayfinder`
  lands on `redline-integration` there, then needs the gitlink *and*
  `wayfinder.pin`'s `ref` moved here in step. Letting those two drift is what
  left redline typechecking against a domain package the fork had moved past.

---

## 2. The lean vertical (current priority)

**Goal: a real procurement corpus goes in, and the results come out on screen,
delineated by topic and brand.** Nothing else. The comprehension-lens work and
the trained-classifier overlay are **deferred** (§3).

**Numbatch is not on this path.** Classification runs cold-start over womblex
extraction: hard rules + LLM adjudication navigating the store's
chunks/provenance, with the nearest-neighbour step deferred. Pricing comes from
womblex's own currency-typed table cells / money sidecars. The Numbatch stack
re-enters only when a *trained* overlay or the financial extension's roll-up is
wanted; neither is needed to see the grid.

The read path is built and merged end to end — store-backed classifier, money
extractor, the served fork, the persisted lens, the write path behind the seed
script, the `/evaluations` index and the document route. See
[`architecture.md`](./architecture.md) §3/§4/§5/§6.

**What is not built is the write *surface*.** The `evaluation` tRPC router has
five `.query()` procedures and **zero mutations** — the only router of thirty in
the fork with none. Nothing in the browser creates an evaluation or starts a
run; `apps/web/scripts/seed-redline-evaluation.ts` does both from a terminal.

Items 1 and 2 close that, and they are genuinely thin: `makeEvaluation`, the
repository write path, `AssignDocumentsToGroups`, the cold-start classifier and
`BuildEvaluationTable` are all built and wired in `container-redline.ts`, wanting
only a mutation and a control in front of them.

**Items 1–3 are fork-side** — the router, the routes and the components all live
in `services/wayfinder/apps/web`. Each is two commits under §1's contract: the
work on `redline-integration`, then the gitlink and pin moved here in step.

**Browser *upload* is deliberately not here.** Staging a corpus needs
`ISAACUS_API_KEY`, compute and a cost decision, so it is an operator action
whoever drives it — and it is the expensive build: redline has no object-storage
code in TypeScript at all, and `IngestDocuments` confirms extraction rather than
performing it (its input is `documentIds`, and its own comment reads *"It does
not trigger womblex itself — that is the sidecar's job"*). A new port, a new
adapter and a sidecar trigger, to remove a step from a user who is not yet in the
loop. Deferred to §3.

### 1 — Create an evaluation from the browser

A `create` mutation on the `evaluation` router, and the route that calls it.
Gate it in the page as well as the procedure, as the index already does.

**This item must settle where the lens comes from.** Nothing authors one (§4.2)
and the authoring surface stays deferred, so the minimum is selecting or
uploading a corpus manifest at create time. Say which, rather than inherit it.

_Version bump: MINOR._
_Exit: a specialist creates a named evaluation in the browser and it appears on
`/evaluations`, empty, without the seed script having run._

### 2 — Run the pipeline from the browser

`IngestDocuments` (the stage confirmation) → `AssignDocumentsToGroups` →
cold-start classify → `BuildEvaluationTable` run only from the script. One
mutation and one control in front of all four, with whatever run state the screen
needs to not look frozen. Documents are already staged and extracted at this
point — that is the operator's step, and stays so.

_Version bump: MINOR._
_Exit: starting a run on an evaluation whose documents have been extracted
produces a populated grid at `/evaluations/:id/review`._

### 3 — Test the React bind layer

`review-table.test.tsx` and `pricing-pivots.test.tsx` are twelve lines each,
asserting only that the export is a function and its `.name` matches — against a
207-line grid and a 157-line pivot component. The cores under `apps/redline-web/`
are covered; the core→DOM binding is not, and the Playwright specs that would
cover it skip until item 4 has run.

_Version bump: PATCH._
_Exit: both components render against fake query data in a test and assert the
rows and columns they produce, failing if the binding to the core breaks._

### 4 — Real corpus, end to end

Run a real procurement corpus through: `womblex` profile ingests → the sidecar
extracts, chunks and embeds → chunk rows and embeddings materialise into the
`redline_` store → group by vendor → cold-start classify → render. Extraction
provenance serves as JSON; bulk vectors are loaded as data but not ANN-indexed.
Needs `ISAACUS_API_KEY` (both the chunk and embed stages are gated) and a corpus
in the git-ignored `services/womblex-ingest/tests/corpus-local/`, which holds
only a README today. The enrich graph is **off in redline's profile**
(`enrichment.enabled: false`); enabling it is a config + Isaacus-cost decision,
and would extend the store-load path to carry graph edges.

Also owns one open measurement: **the three OCR-table gates** (paddleocr-only,
deskew refusal, precision refusal), on the real corpus.

> **Upstream-behaviour facts to bake into the runbook (not obvious from config).**
> (a) `womblex run` writes `elements`/`table_cells`/`form_fields` but **does not
> persist chunks** — `write_batch_parquet` passes only `(doc_id, path, extraction)`
> to `write_results` (`operations/persist.py:18-27`), and chunks hang off
> `result.chunks`. Chunking and embedding are separate per-stage commands
> (`womblex chunk --shards` then `womblex embed --shards`) over the run's shard dir.
> (b) But `run` still *computes* chunking when `chunking.enabled` (`batch.py:63-64`)
> and then discards it, so a keyed run does the work twice. Wasted CPU and wall
> clock, **not** Isaacus spend — redline sets no `chunking_model`, so chunking is
> local semchunk over a vendored tokeniser. Setting `chunking.enabled: false` for
> the `run` pass avoids it and is safe for the prescribed `chunk --shards` path,
> which ignores that flag — but `womblex chunk --config` **refuses outright** when
> it is false (`cli/pipeline.py:417-419`), so do not flip it if anyone uses the
> `--config` composition. (c) The **chunk** stage is Isaacus-gated in 0.3.0 and the
> gate is a **pre-flight policy refusal**, not a capability limit — settled by
> reading the engine, see `architecture.md` §7.1; plan around it rather than
> re-testing it. (d) The **embed** stage is unambiguously Isaacus-gated
> (`kanon-2-embedder`), and **`enrich`/`linking` are disabled** in redline's
> profile (so no graph is produced unless turned on).

_Version bump: PATCH_ (a run plus the runbook and any doc corrections it
produces; no shipped code).

_Exit: a specialist opens the review grid for a real tender and sees each
document delineated by topic and brand, with provenance back to source — with the
five `E2E_REDLINE_EVALUATION_ID`-gated specs
(`services/wayfinder/apps/web/e2e/redline-*.spec.ts`) green against that
evaluation as the automatable half._

### Housekeeping — off the critical path

- **Watch the PGlite hook timeout in the persistence suites.** An earlier
  revision recorded six `Hook timed out in 10000ms` errors across
  `drizzle-{evaluation-repository,money-span-store,chunk-store}.test.ts`. It did
  not reproduce on 2026-08-03 or 2026-08-08 (14/14 green, adapters suite ~23s
  under turbo), so it is load-dependent flakiness, not a standing failure. Raise
  the hook budget if it returns; do not treat it as a known-red gate meanwhile.
  _Version bump: PATCH._
  _Exit: `./validate.sh` green on a cold cache, twice in a row._

---

## 3. Deferred — upload, comprehension lens & release

Deferred until the lean vertical is complete. Revisit the lens work **after** the
corpus run has shown what the cold-start path actually gets right — that evidence
should shape it rather than be assumed. In dependency order:

| Item | Package(s) | Notes |
|---|---|---|
| Browser upload + womblex trigger | domain, adapters, fork | Needs an object-storage port *and* adapter (redline has no object-storage code in TypeScript; `mc cp` stages the bucket today) *and* a seam that starts the sidecar's extract → chunk → embed. Wayfinder's `extraction.ts`/`/api/documents` drive its *own* pipeline into its *own* storage, so the widget may be reusable but the pipeline is not. Splits into at least two build steps. |
| Collision selection, ordering & capping | domain | Bounded, deterministic selection of genuinely ambiguous documents. |
| `BoundaryDecision` entity | domain | Net-new modelling. Owns "primary/secondary semantics" (see §4 item 1). |
| Decision persistence + corrections push | adapters | Shrunk: upstream owns corrections + audit — an adapter call over an existing API, not a build. |
| Lens persistence | adapters | Shrunk: the classification-side tables are built. What remains: the lens's Numbatch bindings (references, not copies), the authoring surface, and the durable-asset surface. |
| Lens portability | application | Apply a saved lens to a different corpus; its boundary decisions still bite. |
| Lens stage machine | redline-web | Define → map → resolve → save, its own machine. |
| Collision resolution surface | redline-web | View model + controller for resolving a collision set. |
| Sample accrual | adapters | Shrunk: upstream topic-scoped dedupe indexes give re-push idempotence for free. |
| Train/activate policy | adapters | Needs redesign — auto-activation contradicts upstream ADR-0021 (activation is a user-controlled pointer move with a replay diff). Surface the upstream flow: auto-*train* on crossing the floor, then let the specialist activate. |
| Workspace extraction & release prep | workspace | Standalone workspace; sever the vendoring seam; graft the financial overlay onto the fork. Last by nature. |

---

## 4. Carried-forward items

1. **Open questions still owned here:** tenancy mapping — Numbatch
   `organisation_id` ↔ Wayfinder identity (settle before a lens is shared between
   users); primary/secondary semantics (Numbatch returns score-sorted ≤3 topics
   with no primary/secondary distinction; owned by `BoundaryDecision` in §3);
   ambiguity thresholds (the signal register needs initial values, unmeasured
   until the corpus runs).

2. **A lens is seeded, not authored.** The corpus driver writes a lens, its
   topics and its hard rules alongside the evaluation, but the lens comes from a
   hand-written manifest. Nothing authors or edits one, and there is no versioning
   or durable-asset lifecycle; that surface stays in §3.

3. **D5 is contradicted by what shipped.** `design-principles.md` still lists
   *"Retrieval is womblex's; redline builds no vector store of its own"* as
   adopted, but the chunks **and their embeddings** are in `redline_chunks`, in
   redline's own Postgres. Retire or reword it; as written the register is
   unreliable.

4. **The D-register has gaps.** `design-principles.md`'s table starts at **D4**,
   yet D1 and D2 are cited as settled. Write D1–D3 in or retire the citations.
   With the ADRs deleted, this register is the only remaining decision record —
   decide whether it survives at all, or collapses into `architecture.md`.

---

## 5. Sequencing

**The lean vertical runs to completion before the deferred work starts.**

Items 1 and 2 make the product operable by someone without a terminal. Item 3
makes the screens they now drive worth trusting. Item 4 is what all of it is for,
and runs last so it proves the product rather than the script — though the script
stays a deliberate fallback for de-risking the first live run on its own.

Then, and only then: §3 in dependency order, and finally workspace extraction and
release.

### What the lean vertical deliberately does not do

- **No browser upload.** Staging the corpus stays an operator action (§3).
- **No trained classifier, no samples, no adapter.** The untrained first pass only.
- **No Numbatch stack.** Re-enters when a trained overlay or the financial
  extension's roll-up is wanted.
- **No comprehension lens.** Collisions, boundary decisions, lens authoring and
  portability all wait.
- **No vector *similarity search*.** The `pgvector`/ANN *index*, `findSimilar` and
  the store-side query-embed path are deferred. The embeddings *are* loaded and
  available; what waits is the nearest-neighbour index over them.
- **No enrich graph by default.** redline's womblex profile disables
  `enrichment`/`linking`; producing and loading the graph is an explicit,
  Isaacus-costed opt-in.
- **No workspace extraction.** Ship-shape is a later concern than see-shape.
