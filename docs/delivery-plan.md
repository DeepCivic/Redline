# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-05 (the UI mount is
> complete — the `evaluation` tRPC router, `container-redline.ts` seam, the
> `/evaluations/:id/{review,pivots,grouping}` routes + components, the
> `evaluation:review` auth gate and the served-fork Playwright specs are all
> merged; the served surface + how it sits now live in architecture.md §3/§6,
> removed from this plan. The cold-start classifier's store (`DrizzleChunkStore`
> over `redline_chunks`) and adjudicator (`HttpAdjudicator`) adapters are now
> built too (architecture.md §3). **A doc-review of the former single "corpus run"
> item split it into the four below** and surfaced its blocker: no evaluation-scoped
> lens can reach `IProcurementClassifier` at the fork's process-wide
> `getContainer()`, and nothing persists a lens at all. Items 1 and 2 close that;
> only then do the bridge, the wiring and the run have anything to classify)
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
the served fork, and §5 below for how they were sequenced. What remains is one
vertical in four steps: give the classifier a lens (items 1–2), wire the live
container (item 3), run a real corpus through it (item 4).

### 1 — The classification lens resolves per request

**The blocker under the wiring, found in doc-review.** `IProcurementClassifier`
has no route from an evaluation to the lens it classifies against.
`ColdStartClassifier` takes `topics`, `ruleSet` and `candidates` as constructor
state (`cold-start-classifier.ts:49-63`), and `NumbatchClassifier` binds its
profile the same way (`numbatch-classifier.ts:52-62`) — but the seam they must be
bound at, the fork's `getContainer()`, is a **process-wide memoised singleton**
(`services/wayfinder/apps/web/src/lib/container.ts:787-793`). `ClassificationRequest`
carries `{ evaluationId, responseGroupId, documentIds }` and no lens, so the
context cannot arrive at call time either. One process therefore cannot serve two
evaluations. This is a gap in the port's design, not in either adapter.

**Resolution: the evaluation-scoped context is read through a port, per call.**
The domain gains `IClassificationLensReader` — `readLens({ evaluationId,
documentIds }) → Result<{ topics, ruleSet, candidates }>` — and
`ColdStartClassifier` takes `{ chunkStore, adjudicator, lensReader }`, resolving
the lens inside `classifyResponseGroup` instead of holding it. `topics` and
`ruleSet` are evaluation-scoped; `candidates` are derived per document from the
request's `documentIds` (identifier tokens, never prose — `hard-rule-evaluation.ts:3-9`).

`IProcurementClassifier` keeps its exact signature, so `BuildEvaluationTable`,
`ClassifyResponseGroup`, `WorkflowController` and `container-redline.ts` are
untouched and port interchangeability (D2; ADR-0008 *"consumers cannot tell which
ran"*) holds. The classifier
becomes a legitimate process-lifetime singleton. The trained overlay takes the
same treatment when it re-enters (§3, *Train/activate policy*); it is off the lean
path today (`NumbatchClassifier` is not rewired here).

_Version bump: MINOR_ (new domain port, changed application constructor).

_Exit: a vitest suite in which one `ColdStartClassifier`, constructed once with
only `{ chunkStore, adjudicator, lensReader }`, classifies two response groups
belonging to different evaluations against different lenses from a fake reader,
and returns each group's own topics._

### 2 — A persisted lens for the reader to read

Nothing stores a lens. `schema.ts` has no lens, topic, requirement or hard-rule
table — `redline_evaluations` is `{ id, name, stage }` — so even with item 1's port
there is nothing behind it, and a real corpus has nothing to be classified
against. This is the lean vertical's minimum: the classification-side subset of
§3's *Lens persistence*, which shrinks accordingly (that item keeps the lens's
Numbatch bindings and the durable-asset surface).

Migration + `DrizzleClassificationLensReader` implementing item 1's port:
`redline_lenses` (lens identity), `redline_hard_rules`, and the lens↔evaluation
binding — all three explicitly sanctioned by ADR-0009, which puts *"the lens (its
identity, its criteria references, its hard rules, its boundary decisions) and
the bindings"* in `redline_` tables. Standard conventions: `redline_` prefix,
snake_case columns, `id`/`created_at`/`updated_at` each. A `Lens` carries no
`evaluationId` (ADR-0009) — the binding is its own row, not a field on the lens.
`candidates` are derived, not stored: identifier tokens from the extraction
reader.

> **Blocked on a decision, not on code: where do cold-start topic *definitions*
> live?** ADR-0009 keeps `topics` in Numbatch as the system of record and permits
> redline only *references*. But `ColdStartClassifier` adjudicates over each
> topic's **definition text** (`cold-start-classifier.ts:52-56`), and §2 excludes
> the Numbatch stack entirely — so on the lean path there is no system of record
> to dereference. ADR-0009 half-anticipates this (*"under ADR-0008 the first pass
> needs no Numbatch at all, so a lens stays definable… with the fork down"*) while
> its *Alternatives considered* rejects mirroring the library into `redline_`
> tables. That is unresolved, and it decides this item's schema. **Settle it in an
> ADR before building** — the likely shape is that cold-start definitions are
> redline-owned and Numbatch's library is the system of record only for the
> *trained* overlay's topics and samples, which would amend ADR-0009 narrowly
> rather than overturn it. Do not quietly add a `redline_lens_topics` table
> instead.

_Version bump: MINOR_ (schema change).

_Exit: an integration test against a real Postgres — a lens saved with its hard
rules and its evaluation binding reads back byte-identical through
`IClassificationLensReader`, and a document's `candidates` derive from an
extraction fixture._

### 3 — The fork bridge and the live `getContainer()`

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
cold-start classifier over `DrizzleChunkStore` + `HttpAdjudicator` + item 1's lens
reader, money `IFinancialExtractor`, the bridge, product name) and hang
`buildRedlineModule`'s controller on `ctx.container.redline`, mirroring
`buildExtractionModule` (`container.ts:204`, `:481`). Keep the wiring in the
module, not inline: `container.ts` is already 795 lines.

(The grouping route's interactive composition surface — assign/advance over the
`WorkflowManager` — is not part of this; it lands with the lens stage machine, §3.)

_Version bump: MINOR_ (new adapter, new runtime wiring; no schema change).

_Exit: a vitest suite asserting the bridge maps a summary request onto
`generateText` with a `purpose` and surfaces a model failure as a `Result` error
rather than a throw, and that `buildRedlineModule` composes green from the real
adapters._

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
| Lens persistence | adapters | Shrunk by §2 item 2, which lands the classification-side tables. What remains: the lens's Numbatch bindings (references, not copies) and the durable-asset surface. |
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

2. **Where cold-start topic definitions live** — ADR-0009 makes Numbatch's library
   the system of record for `topics` and allows redline references only, but the
   lean vertical runs with no Numbatch and the adjudicator needs definition text.
   Blocks §2 item 2's schema; needs an ADR (see that item).

3. **The D-register has gaps.** `design-principles.md`'s table starts at **D4**,
   yet D1 (`.claude/CLAUDE.md`) and D2 (five files under `packages/`, meaning port
   interchangeability) are cited as settled decisions. D1–D3 should be written into
   the register or the citations retired.

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
1. **The four items of §2, in order.** They are strictly dependent: the lens
   reader port (1) has nothing behind it until a lens is persisted (2); the
   `getContainer()` wiring (3) cannot construct a classifier until both exist; and
   the corpus run (4) is what the wiring is for. The point of the exercise is (4);
   1–3 are what a doc-review found standing between the plan and it. **Item 2 is
   additionally gated on an ADR** — ADR-0009 puts topic definitions in Numbatch
   while the lean vertical excludes it (§2 item 2, §4 item 2). Item 1 is
   unblocked and can start now.

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
