# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-08
>
> **The superseded retrieval leg is deleted** (2026-08-08). `ClassifyByRetrieval`,
> `IEmbeddingReader`, `ITextEmbedder`, the two womblex embeddings adapters and
> their wire parsers and fixtures — ~1,300 lines ADR-0017/0018 had superseded but
> which were still exported and still running tests — are gone. Nothing outside
> those files referenced them, in this repo or in the fork on either the pinned
> commit or the branch tip.
>
> **The corpus write path is built.** `IngestDocuments` → lens seed →
> `AssignDocumentsToGroups` → `BuildEvaluationTable` now runs end to end from a
> corpus manifest: `IClassificationLensWriter` + `DrizzleClassificationLensWriter`
> (the four lens tables had a reader and no writer, so `readLens` returned
> `NOT_FOUND` for every evaluation and classification could not run at all), and
> in the fork `redline-corpus-manifest.ts`, `redline-seed-evaluation.ts` and
> `scripts/seed-redline-evaluation.ts`. It is proven against in-memory adapters,
> **not** against live services — the live run is the corpus item's business.
>
> **Everything now points at johntooth/wayfinder** (2026-08-08). The fork gitlink
> and `wayfinder.pin` both track `redline-integration` at `c0967c5`; the pin's
> `repo` was naming `rbrasier/wayfinder`, which CI was cloning literally.
> `validate.sh` #15 lost its "main undiverged from upstream" half — it policed a
> clean upstreaming diff to rbrasier, a relationship redline does not have.
> **`./validate.sh` is 14/14 green on a fully initialised clone**, which it had
> never been: the previously recorded green depended on leaving the fork
> submodule uninitialised so #15 would SKIP.
>
> **ADRs are gone** (2026-08-08). `docs/adr/` is deleted and no skill instructs
> writing one. Decisions are made and recorded in the commit that acts on them;
> no document gates a build. Citations of the form `ADR-00NN` still appear in
> code comments and in this file — they read as historical markers now.
>
> **The served UI is read-only, and this plan had not recorded it** (found
> 2026-08-08). Five queries, zero mutations, four read routes: nothing in the
> browser creates an evaluation, uploads a document or starts a run — the seed
> script does all three. The plan previously said "what remains is one step: run
> a real corpus", which was wrong in kind. §2 items 1–5 now carry that work, and
> the corpus run sits behind them.
>
> **One thing found while building, still needing a decision.**
>
> - **A topic id is global.** `redline_topics.id` is a plain primary key, so a
>   topic belongs to exactly one lens and a second lens reusing an id fails. Fine
>   for now; it will need revisiting when lens portability (§3) lands.
>
> **Built and merged before that.** Two items came off the vertical:
>
> - **The persisted lens** — `redline_lenses`, `redline_topics`,
>   `redline_hard_rules` and `redline_lens_bindings`, read through
>   `DrizzleClassificationLensReader`. Topics and rules come back in stored order
>   (`position`, `declaration_order` — the latter load-bearing under ADR-0011);
>   `candidates` derive per call from an identifier-token pre-pass over
>   `readElements`, which is the adapter's second collaborator.
> - **The live `getContainer()` wiring** (`services/wayfinder`) —
>   `resolveRedlineModule` binds all six ports to production adapters, and
>   `redline-language-model.ts` maps redline's `summarise` onto Wayfinder's
>   `generateText`. The three prerequisites that item carried landed with it: the
>   `@redline/redline-adapters` dependency, the `REDLINE_*` env keys (**all
>   optional**, so the fork still boots as plain Wayfinder when the redline stack
>   is absent), and [`guides/two-stack-local-run.md`](./guides/two-stack-local-run.md).
>
> Everything earlier — the UI mount, the store-backed classifier and adjudicator,
> the pricing leg — lives in architecture.md §3/§6 and is out of this plan.
>
> **Nothing here has been run against live services.** The wiring and the write
> path typecheck and are unit-tested; no Postgres, sidecar or adjudicator has
> ever been behind either. Expect config-level breakage on first boot, and treat
> the corpus run (§2 item 6) as the first real proof rather than a formality.
>
> **Revised after a pre-user-testing review of the whole outstanding set.** That
> review verified every "built" claim above against the trees (the submodules were
> uninitialised; they were initialised to read the fork) and found the vertical
> short of its own goal in three places: the lens item's table list was missing
> the topics table ADR-0020 sanctions (now built, with that table); nothing
> created an evaluation or built the review table (now built, above); and the
> review grid's provenance deep-link pointed at a route that did not exist — the
> `/evaluations/:id/documents/:documentId` view is now built too. That review
> then concluded the corpus run was the only step left, which the 08-08 read of
> the fork disproved: it had checked what renders, not what a specialist can
> *do*. Housekeeping that is not on the vertical but is wanted before users is at
> the end of §2.
>
> **This tracks outstanding work only. It does not restate design.**
> [`architecture.md`](./architecture.md) is the single source of truth for *what
> redline is and how data moves through it*;
> [`design-principles.md`](./design-principles.md) holds the durable adopted
> principles and non-goals. This file holds *what is left to do* and nothing else.
> Completed work and the reasoning behind superseded plans live in git history.
>
> Item numbers here are local to this document and are renumbered whenever the
> outstanding set changes; they carry no history and never need to line up with
> anything in the code.

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
extraction (ADR-0008's
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
built too, so `IClassificationLensReader` now has an adapter behind it, and the
write path that creates, seeds, groups and builds an evaluation is built on top
of it. The document route the provenance deep-links point at is built as well.

**But the served UI is read-only, and the plan did not say so** (found
2026-08-08, by reading the fork rather than this file). The `evaluation` tRPC
router has **five `.query()` procedures and zero mutations**; the route set is
the `/evaluations` index plus four read views. Nothing in the browser creates an
evaluation, ingests a document, or starts a classification run — all of that is
`apps/web/scripts/seed-redline-evaluation.ts`, a CLI script an operator runs in
a terminal. So the goal above is half-met: the results come out on screen, but
the corpus goes in through a shell.

**How much is "only a surface" varies sharply by item, and a first draft of this
section got it wrong.** Creating an evaluation and running the pipeline really
are thin — `makeEvaluation`, the repository write path,
`AssignDocumentsToGroups`, the cold-start classifier and `BuildEvaluationTable`
are all built and wired in `container-redline.ts`, wanting only a mutation.
**Getting a document in is not.** Two facts settle it:

- **`IngestDocuments` does not ingest.** Its input is `documentIds: string[]`,
  and its job is to confirm each already-extracted document reads back through
  `IProcurementExtractionReader` and advance the stage. Its own comment: *"It
  does not trigger womblex itself — that is the sidecar's job."*
- **redline has no object-storage code in TypeScript at all** — no port, no
  adapter, no client, in any package. Files reach redline's bucket by `mc cp` in
  `scripts/womblex-engine-smoke.sh`, staged to `proc/{evaluationId}/inputs/`,
  after which the sidecar extracts, chunks and embeds.

So a browser upload needs a new port *and* adapter *and* a sidecar trigger — the
build-step contract splits that, hence items 2 and 3 below. **Wayfinder's own
document machinery does not close it**: `extraction.ts` (10 queries, 19
mutations), `document.ts` and `/api/documents` drive Wayfinder's *own*
extraction pipeline into Wayfinder's storage, not womblex into redline's bucket.
The upload *widget* may be reusable; the pipeline behind it is not, and
substituting it would contradict the architecture. Worth confirming against
`apps/web` before item 2 starts, since reusing the widget would shrink it.

Items 1–4 close the gap, item 5 covers a hole they expose, and the corpus run
(item 6) comes last so it proves the product a specialist uses rather than a
script — the script stays available if you want to de-risk the first live run
without also debugging new UI.

### 1 — Create an evaluation from the browser

Add a `create` mutation to the `evaluation` router and the route that calls it.
Gate it in the page as well as in the procedure, as the index already does, so a
user without `evaluation:review` gets neither.

**This item must answer where the lens comes from.** Nothing authors a lens
(§4.2) and the authoring surface stays deferred (§3), so the minimum here is
selecting or uploading a corpus manifest at create time. Decide it in this item
rather than assuming it.

_Version bump: MINOR._
_Exit: a specialist creates a named evaluation in the browser and it appears on
`/evaluations`, empty, without the seed script having run._

### 2 — An object-storage port, so redline can put a file in its own bucket

redline writes nothing to object storage from TypeScript today; `mc cp` in a
shell script does it. Add the port in `redline-domain` and the adapter in
`redline-adapters`, writing to `proc/{evaluationId}/inputs/` — the layout the
sidecar already reads. No UI in this item.

_Version bump: MINOR._
_Exit: the adapter puts a file at the sidecar's expected key and reads it back,
against a real bucket in the compose stack._

### 3 — Upload documents from the browser, and start the womblex run

Item 2's port behind an upload mutation and control, plus the seam that triggers
the sidecar's extract → chunk → embed for the uploaded set. Check first whether
Wayfinder's existing upload component can be reused for the file-picking half;
only the pipeline behind it has to be redline's.

Crosses TypeScript and the Python sidecar, so expect the seam — an endpoint or a
job — to be the real work rather than the widget.

_Version bump: MINOR._
_Exit: a specialist uploads documents to an evaluation in the browser and, once
the sidecar finishes, they read back through `IProcurementExtractionReader`._

### 4 — Run the pipeline from the browser

`IngestDocuments` (the stage confirmation) → `AssignDocumentsToGroups` →
cold-start classify → `BuildEvaluationTable` run only from the script. All four
are wired in `container-redline.ts`; put one mutation and one control in front
of them, with whatever run state the screen needs to not look frozen.

_Version bump: MINOR._
_Exit: starting a run on an evaluation whose documents have been extracted
produces a populated grid at `/evaluations/:id/review`._

### 5 — Test the React bind layer

`review-table.test.tsx` and `pricing-pivots.test.tsx` are twelve lines each,
asserting only that the export is a function and its `.name` matches — against a
207-line grid and a 157-line pivot component. The cores under
`apps/redline-web/` are covered and the served DOM is not; the Playwright specs
that would cover it skip without `E2E_REDLINE_EVALUATION_ID`, which does not
exist until item 6 has run. Nothing tests the binding between core and DOM.

_Version bump: PATCH._
_Exit: both components render against fake query data in a test and assert the
rows and columns they produce, failing if the binding to the core breaks._

### 6 — Real corpus, end to end

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
five `E2E_REDLINE_EVALUATION_ID`-gated specs
(`services/wayfinder/apps/web/e2e/redline-*.spec.ts`) green against that
evaluation as the automatable half._

### Housekeeping — off the vertical, wanted before users

Not on the critical path.

- **Watch the PGlite hook timeout in the persistence suites.** An earlier
  revision recorded `./validate.sh` as FAILing with six `Hook timed out in
  10000ms` errors across
  `drizzle-{evaluation-repository,money-span-store,chunk-store}.test.ts`. **It did
  not reproduce on 2026-08-03, nor on 2026-08-08** — a full `./validate.sh` ran
  green (14/14 on the 08-08 run) with the
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
   mapping — Numbatch `organisation_id` ↔ Wayfinder identity (must be settled
   before a lens is shared between users); primary/secondary semantics (net-new
   modelling — Numbatch returns score-sorted ≤3 topics with no primary/secondary
   distinction; owned by the `BoundaryDecision` item in §3); ambiguity thresholds
   (the signal register needs initial values, unmeasured until a real corpus runs
   — §2).

2. **A lens is seeded, not authored.** `IClassificationLensWriter` and the
   corpus driver now write a lens, its topics and its hard rules alongside the
   evaluation, so classification can run — but the lens still comes from the
   manifest the operator hand-writes. No UI or use-case authors or edits one, and
   there is no versioning or durable-asset lifecycle; that surface stays in §3.

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
   leg, which has now been **deleted** (2026-08-08): `ClassifyByRetrieval`,
   `IEmbeddingReader`, `ITextEmbedder` and the womblex embeddings adapters are gone
   from the tree, their invariants living on in ADR-0014/0018 and the chunk store.
   The money `IFinancialExtractor` (`MoneySpanFinancialExtractor`)
   is likewise built: it sums a document's table-cell money spans over
   `IMoneySpanStore` into grid AUD, wired behind the port in `lib/container.ts`
   (architecture.md §4 step 7 / §7 item 4). The UI mount lands in the forked
   Wayfinder (`services/wayfinder`, branch `redline-integration`), not in
   `apps/redline-web` —
   ADR-0019: the
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
   `./validate.sh` (architecture.md §3). The persisted lens and the live wiring
   followed (2026-08-03): `DrizzleClassificationLensReader` over the four lens
   tables, then `resolveRedlineModule` + the `ILanguageModel` bridge in the fork.
   `validate.sh` was 13/13 at the time and the fork's typecheck went 3 errors → 0 — one of
   those was pre-existing, `container-redline.test.ts` still composing
   `buildColdStartClassifier` with `topics`/`ruleSet`/`candidates` after the lens
   moved behind `IClassificationLensReader`.
1. **The write path is built** (2026-08-03), on top of that wiring: the lens
   writer in `redline-adapters` and, in the fork, the manifest reader, the
   seeding composition and `scripts/seed-redline-evaluation.ts`. Proven against
   in-memory adapters only — the live run is §2 item 6.

2. **The way *to* it is built** (2026-08-03): `listEvaluations()` on
   `IEvaluationRepository` and `DrizzleEvaluationRepository`, the router's `list`
   procedure, the `/evaluations` index and the sidebar entry — the first thing in
   Wayfinder's chrome that links to redline at all. The index gates in the page as
   well as in the procedure, so a user without `evaluation:review` gets neither the
   entry nor the route. This is a way to *reach* evaluations, not a way to
   *make* one — an earlier revision of this file called it "the way in", which
   overstated it and hid §2 items 1–3.

3. **The document route is built** (2026-08-03): `WorkflowController.openDocument`
   reads the cited document's elements through `IProcurementExtractionReader`,
   `renderDocumentView` orders them and resolves the `element` query parameter to
   an anchor, and the fork serves `/evaluations/:id/documents/:documentId` beside
   its siblings, gated in the page as well as in the procedure. Every provenance
   deep-link the review grid and the Excel export write now resolves, which is
   what §2 item 6's exit test needs to pass honestly.

4. **§2 items 1–4, the write surface.** Create, upload, run — from the browser.
   Items 1 and 4 are thin: the use-cases are built and wired, wanting only a
   mutation and a control. Items 2 and 3 are not, because redline has no
   object-storage code in TypeScript and `IngestDocuments` confirms extraction
   rather than performing it — getting a file in means a new port, a new adapter
   and a sidecar trigger. Until all four land, the only operator is someone with
   a terminal and the seed script.

5. **§2 item 5, the bind-layer tests**, which items 1–4 make worth having: once
   a specialist can drive the screens, an untested core→DOM binding is the most
   likely place for a silent wrong number.

6. **§2 item 6, the corpus run.** What all of it is for. Running it after 1–4
   proves the product rather than the script — though the script remains a
   deliberate fallback for de-risking the first live run on its own.

   **Two open decisions inside §2.** Item 1 must settle where a
   browser-created evaluation's lens comes from, since nothing authors one
   (§4.2); the manifest is the expected answer, and the item must say so rather
   than inherit it. Item 3 must settle whether Wayfinder's existing upload
   component can be reused for file-picking — the pipeline behind it cannot be,
   but reusing the widget would shrink the item.

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
