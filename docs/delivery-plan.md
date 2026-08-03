# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-03 (the UI mount is
> complete — the `evaluation` tRPC router, `container-redline.ts` seam, the
> `/evaluations/:id/{review,pivots,grouping}` routes + components, the
> `evaluation:review` auth gate and the served-fork Playwright specs are all
> merged; the served surface + how it sits now live in architecture.md §3/§6,
> removed from this plan. The cold-start classifier's store (`DrizzleChunkStore`
> over `redline_chunks`) and adjudicator (`HttpAdjudicator`) adapters are built,
> as is `IClassificationLensReader` — the classifier resolves its evaluation's
> lens per call, so one instance serves a process-wide `getContainer()`. **The
> persisted lens now sits behind that reader**: `redline_lenses`,
> `redline_topics`, `redline_hard_rules` and `redline_lens_bindings` ship with
> `DrizzleClassificationLensReader` and its identifier-token pre-pass
> (architecture.md §3). The wiring, the write path and the run now have something
> to classify against)
>
> **Revised after a pre-user-testing review of the whole outstanding set.** That
> review verified every "built" claim above against the trees (the submodules were
> uninitialised; they were initialised to read the fork) and found the vertical
> short of its own goal in three places, now tracked here rather than assumed:
> the lens item's table list was missing the topics table ADR-0020 sanctions (now
> built, with that table); **nothing creates an evaluation or builds the review
> table** (item 2); and the review grid's provenance deep-link points at a route
> that does not exist (item 3). Item 1 gained the three prerequisites it needs to
> compile at all. Housekeeping that is not on the vertical but is wanted before
> users is at the end of §2.
>
> **A note on ADRs, since an earlier revision got this wrong.** An ADR records a
> decision; it does not gate a build. This plan previously carried "do not build
> until the ADR's PR is merged" language against the lens item. That was a
> mistake in kind, not just in fact — where a decision is unsettled, say what is
> unsettled and what the item assumes, and keep building.
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
the served fork, and §5 below for how they were sequenced. The persisted lens is
built too, so `IClassificationLensReader` now has an adapter behind it. What
remains is one vertical in four steps: wire the live container (item 1), give it
a write path that creates and builds an evaluation (item 2), serve the document
view its provenance links point at (item 3), and run a real corpus through the
lot (item 4).

### 1 — The fork bridge and the live `getContainer()`

The seam the *served* UI waits on. Two pieces, both in the fork
(`services/wayfinder`, branch `redline-integration` — ADR-0019 sanctions this
tree; `vendor/wayfinder` and the Python submodules stay read-only):

**The `ILanguageModel` bridge**, as `apps/web/src/lib/redline-language-model.ts`
beside `container-redline.ts`. It lives in the fork, not `packages/redline-adapters`,
because the fork's `apps/web` resolves `@rbrasier/*` and `@redline/*` alike, while
redline-adapters can only reach `@rbrasier/domain` through ADR-0012's optional
runtime load (the `wayfinder-contract.ts` dance) — a cost with nothing to buy here,
since the fork's model instance only exists in the fork's container anyway.
It maps redline's `summarise({ vendorName, productName, passages }) → Result<string>`
onto the fork's **`generateText`** — verified at
`services/wayfinder/packages/domain/src/ports/language-model.ts:96-98`, returning
`Result<{ text: string; usage: TokenUsage }>`. **Not `generateObject<T>`**: that
one demands a schema and returns `{ object: T }`, which would mean inventing a
wrapper schema for a paragraph. `purpose` is required on every call and labels the
usage record.

**The `getContainer()` call** — bind the six ports (repository, extraction reader,
cold-start classifier over `DrizzleChunkStore` + `HttpAdjudicator` + the lens
reader, money `IFinancialExtractor`, the bridge, product name) and hang
`buildRedlineModule`'s controller on `ctx.container.redline`, mirroring
`buildExtractionModule` (`container.ts:204`, `:481`). Keep the wiring in the
module, not inline: `container.ts` is already 795 lines.

**Three prerequisites this item has to carry, none of which exist yet.** Each was
verified absent; without them the wiring does not compile or does not boot:

- **`@redline/redline-adapters` is not a dependency of the fork's `apps/web`.**
  Its `package.json` lists `redline-application`, `redline-domain`,
  `redline-shared` and `redline-web` — but not `redline-adapters`, which is where
  every production adapter this item binds actually lives
  (`DrizzleEvaluationRepository`, `DrizzleChunkStore`, `HttpAdjudicator`,
  `DrizzleMoneySpanStore`, `WomblexExtractionReader`). The `../../packages/*`
  workspace glob already covers it, so this is one dependency line.
- **The fork's env schema has no `REDLINE_*` key at all.** `apps/web/src/lib/env.ts`
  is a strict zod schema that fails fast on boot. The wiring needs redline's own
  Postgres URL (`REDLINE_DATABASE_URL` — ADR-0002 keeps it separate from
  Wayfinder's `DATABASE_URL`), the `HttpAdjudicator`'s `baseUrl` / `apiKey` /
  `model`, the womblex-ingest base URL, and the evaluation's product name.
- **No runtime story for running both stacks.** `infra/docker-compose.yml` has no
  service for the fork's web app, and the fork needs its own Postgres/Redis/MinIO
  beside redline's. Whether that is a compose profile here, a documented two-stack
  runbook, or a `services/wayfinder` compose overlay is this item's call to make —
  but user testing cannot start without one.

(The grouping route's interactive composition surface — assign/advance over the
`WorkflowManager` — is not part of this; it lands with the lens stage machine, §3.
The served grouping page is a read-only landing that routes into review and
pivots, which is honest but means testers cannot compose groups in the UI — see
item 2.)

_Version bump: MINOR_ (new adapter, new runtime wiring; no schema change).

_Exit: a vitest suite asserting the bridge maps a summary request onto
`generateText` with a `purpose` and surfaces a model failure as a `Result` error
rather than a throw, and that `buildRedlineModule` composes green from the real
adapters._

### 2 — An evaluation can be created, grouped and built

**The vertical's missing middle, and the item most directly between here and user
testing.** The store-load path fills `redline_chunks`; the review grid reads
persisted `ProcurementResponse[]`. Nothing joins them.

`IngestDocuments` — the use-case that calls `makeEvaluation` and writes the
evaluation row — is exported from `@redline/redline-application` and **called by
nothing outside its own test**. `WorkflowController.buildTable()` exists
(`apps/redline-web/src/lib/container.ts:103`) and is reachable from no served
procedure: the fork's `evaluationRouter` exposes `reviewGrid`, `pricingPivot` and
`workbook`, all read-side. So after a corpus lands there is still no path — served
or scripted — that creates the evaluation, records its vendors and response
groups, runs the classifier and persists the rows the grid reads. Item 5's exit
test is unreachable without this, and `E2E_REDLINE_EVALUATION_ID` has nothing to
point at.

Scope is the write path, not a UI: a driver that runs
`IngestDocuments` → `AssignDocumentsToGroups` → `BuildEvaluationTable` against the
live container. A script or CLI in the fork is enough and is the smaller step; a
tRPC mutation is the larger one and drags in the stage machine (§3) it should not
own yet. Vendors and response groups have to come from somewhere the operator
controls — a manifest read from the corpus directory is the cheapest honest
answer, since the served grouping page is read-only until §3's stage machine
lands.

_Version bump: MINOR_ (new runtime surface; no schema change).

_Exit: running the driver against a seeded corpus produces an evaluation whose
`listResponses` is non-empty and whose stage is `review`, and the id it prints
opens the served review grid._

### 3 — The document route the provenance link points at

Every review row renders a source deep-link, and every one of them 404s.
`review-view.ts:63-67` builds
`/evaluations/:id/documents/:documentId?element=…&page=…&chunk=…`; the fork serves
only `review`, `pivots` and `grouping` under `[id]`. The e2e spec does not catch
it — `redline-review-grid.spec.ts:75` asserts the `href` *pattern* and never
follows it.

Item 5's exit test says *"with provenance back to source"*, and provenance a
specialist cannot click is not provenance. Build the route in the fork beside the
others: read the document's elements through `IProcurementExtractionReader` (the
JSON presentation seam ADR-0003/0017 keeps for exactly this), anchor on the
`element` query parameter, gate it on `evaluation:review` like its siblings.

_Version bump: MINOR_ (new served route; no schema change).

_Exit: a Playwright spec that clicks a review row's source link and lands on the
document view scrolled to the cited element — the assertion the current spec
stops short of._

### 4 — Real corpus, end to end

Run a real procurement corpus through: `womblex` profile ingests → the sidecar
extracts, chunks and embeds (see the runbook note below) → chunk rows and
embeddings (as retrievable data) materialise into the `redline_` store (the
store-load path, built) → group documents by vendor → cold-start classify over
the store (hard rules + adjudication over exact fetch, no nearest-neighbour step
yet — built) → render. Extraction provenance still serves as JSON (ADR-0003/0017);
bulk vectors are loaded into the store as data but not yet ANN-indexed (ADR-0018
addendum). Needs `ISAACUS_API_KEY` (both the chunk and embed stages are gated — see
below) and a corpus in the git-ignored `services/womblex-ingest/tests/corpus-local/`,
which holds only a README today. The enrich graph is **off in redline's profile**
(`enrichment.enabled: false`); enabling it — if the graph is wanted for navigation
— is a config + Isaacus-cost decision, not an assumed default, and would extend the
store-load path to carry graph edges too.

Also the owner of one open item: **measure the three OCR-table gates**
(paddleocr-only, deskew refusal, precision refusal) on the real corpus.

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
> `--config` composition. (c) The **chunk**
> stage is Isaacus-gated in 0.3.0 and the gate is a **pre-flight policy refusal**,
> not a capability limit — settled by reading the engine, see `architecture.md` §7.1;
> plan around it rather than re-testing it. (d) The **embed** stage is
> unambiguously Isaacus-gated (`kanon-2-embedder`), and **`enrich`/`linking` are
> disabled** in redline's profile (so no graph is produced unless turned on).

_Version bump: PATCH_ (a run plus the runbook and any doc corrections it produces;
no shipped code).

_Exit: a specialist opens the review grid for a real tender and sees each
document delineated by topic and brand, with provenance back to source — with the
four `E2E_REDLINE_EVALUATION_ID`-gated specs
(`services/wayfinder/apps/web/e2e/redline-*.spec.ts`) green against that
evaluation as the automatable half._

### Housekeeping — off the vertical, wanted before users

Neither is on the critical path; both were found by the pre-user-testing review
and both are cheap.

- **Delete the superseded retrieval leg (~1,260 lines of dead code).** §5 below
  already records `ClassifyByRetrieval` / `IEmbeddingReader` / `ITextEmbedder` and
  the womblex embeddings adapters as superseded by ADR-0017/0018 — but every one
  of them is still in the tree, still exported from
  `packages/redline-adapters/src/index.ts`, and still running tests. `AGENTS.md`:
  *"No dead code — if something is unused, delete it entirely."* The surviving
  invariants live in ADR-0018 and the chunk store, not in these files.
  _Version bump: PATCH._
  _Exit: the files are gone and `./validate.sh` is green._

- **Watch the PGlite hook timeout in the persistence suites.** An earlier
  revision recorded `./validate.sh` as FAILing with six `Hook timed out in
  10000ms` errors across
  `drizzle-{evaluation-repository,money-span-store,chunk-store}.test.ts`. **It did
  not reproduce on 2026-08-03** — a full `./validate.sh` ran 13/13 green with the
  adapters suite finishing in ~23s under turbo. So this is load-dependent
  flakiness on a slower or busier machine, not a standing failure. Raise the hook
  budget if it returns; do not treat it as a known-red gate in the meantime.
  _Version bump: PATCH._
  _Exit: `./validate.sh` green on a cold cache, twice in a row._

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
| Lens persistence | adapters | Shrunk: the classification-side tables (`redline_lenses` / `redline_topics` / `redline_hard_rules` / `redline_lens_bindings`) are built. What remains: the lens's Numbatch bindings (references, not copies), the authoring surface, and the durable-asset surface. |
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

2. **Nothing authors a lens.** The lens is persisted and readable, but every row
   is operator-seeded — there is no UI, use-case or driver that creates a lens,
   its topics or its hard rules. A tester cannot classify anything until one
   exists, so item 2's write path (or its manifest) has to seed a lens alongside
   the evaluation, and the lens-authoring surface proper stays in §3.

3. **D5 is contradicted by what shipped.** `design-principles.md` still lists
   *"Retrieval is womblex's; redline builds no vector store of its own"* as an
   adopted principle, but ADR-0017/0018 put the chunks **and their embeddings**
   in `redline_chunks`, in redline's own Postgres. The principle needs retiring
   or rewording to match ADR-0018; leaving it as written makes the register
   unreliable.

4. **The D-register has gaps.** `design-principles.md`'s table starts at **D4**,
   yet D1 (`.claude/CLAUDE.md`) and D2 (five files under `packages/`, meaning port
   interchangeability) are cited as settled decisions. D1–D3 should be written into
   the register or the citations retired.

---

## 5. Sequencing

**The lean vertical runs to completion before the deferred work starts.**

0. **The store-backed retrieval leg, the pricing leg and the UI mount are built**
   (merged 2026-08-01 → 2026-08-03). ADR-0017 and ADR-0018 (merged 2026-07-31)
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
1. **The four items of §2, in order.** Items 1–2 are strictly dependent: the
   `getContainer()` wiring (1) can now construct a classifier, since the lens it
   reads is persisted; and nothing can create an evaluation or build its table
   until that wiring exists (2). The corpus run (4) is what all of it is for, and
   is the point of the exercise.

   Item 3's document route can start immediately and in parallel — it depends
   only on the extraction reader, which is built. It is not a prerequisite of
   item 4, but item 4's exit test asserts provenance a specialist can follow, so
   it must land before that test can honestly pass.

   **Nothing in §2 is gated on a decision.** ADR-0020 settled where cold-start
   topic definitions live and the lens schema is built against it.

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
