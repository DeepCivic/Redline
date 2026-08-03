# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-03
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
> **Two things found while building it, both needing a decision.**
>
> - **The fork's `redline-integration` branch does not carry the live
>   `getContainer()` wiring.** The superproject pins `d177bf07`, which sits on
>   `origin/claude/delivery-plan-user-testing-bses4f` and is *not* an ancestor of
>   `redline-integration`. The Redline-side PR merged; the fork-side branch never
>   did. The seeding work is branched from the pin, so it carries the wiring —
>   but both need merging into `redline-integration` before `validate.sh` #15 can
>   be green, since that check asserts the checkout is on that branch.
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
> the corpus run (item 1) as the first real proof rather than a formality.
>
> **Revised after a pre-user-testing review of the whole outstanding set.** That
> review verified every "built" claim above against the trees (the submodules were
> uninitialised; they were initialised to read the fork) and found the vertical
> short of its own goal in three places: the lens item's table list was missing
> the topics table ADR-0020 sanctions (now built, with that table); nothing
> created an evaluation or built the review table (now built, above); and the
> review grid's provenance deep-link pointed at a route that did not exist — the
> `/evaluations/:id/documents/:documentId` view is now built too, so the corpus
> run is the only step left on the vertical. Housekeeping that is not on the
> vertical but is wanted before users is at the end of §2.
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
built too, so `IClassificationLensReader` now has an adapter behind it, and the
write path that creates, seeds, groups and builds an evaluation is built on top
of it. The way in is built too — `listEvaluations()`, the router's `list`, the
`/evaluations` index and the sidebar entry that points at it. The document route
the provenance deep-links point at is built as well, so what remains is one step:
run a real corpus through the lot (item 1).

### 1 — Real corpus, end to end

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

Neither is on the critical path; both were found by the pre-user-testing review
and both are cheap.

- **Delete the superseded retrieval leg (~1,321 lines of dead code).** §5 below
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
   `./validate.sh` (architecture.md §3). The persisted lens and the live wiring
   followed (2026-08-03): `DrizzleClassificationLensReader` over the four lens
   tables, then `resolveRedlineModule` + the `ILanguageModel` bridge in the fork.
   `validate.sh` is 13/13 and the fork's typecheck went 3 errors → 0 — one of
   those was pre-existing, `container-redline.test.ts` still composing
   `buildColdStartClassifier` with `topics`/`ruleSet`/`candidates` after the lens
   moved behind `IClassificationLensReader`.
1. **The write path is built** (2026-08-03), on top of that wiring: the lens
   writer in `redline-adapters` and, in the fork, the manifest reader, the
   seeding composition and `scripts/seed-redline-evaluation.ts`. Proven against
   in-memory adapters only — the live run is item 1.

2. **The way in is built** (2026-08-03): `listEvaluations()` on
   `IEvaluationRepository` and `DrizzleEvaluationRepository`, the router's `list`
   procedure, the `/evaluations` index and the sidebar entry — the first thing in
   Wayfinder's chrome that links to redline at all. The index gates in the page as
   well as in the procedure, so a user without `evaluation:review` gets neither the
   entry nor the route.

3. **The document route is built** (2026-08-03): `WorkflowController.openDocument`
   reads the cited document's elements through `IProcurementExtractionReader`,
   `renderDocumentView` orders them and resolves the `element` query parameter to
   an anchor, and the fork serves `/evaluations/:id/documents/:documentId` beside
   its siblings, gated in the page as well as in the procedure. Every provenance
   deep-link the review grid and the Excel export write now resolves, which is
   what §2's exit test needs to pass honestly.

4. **The one item of §2.** The corpus run is what all of it is for, and is the
   point of the exercise.

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
