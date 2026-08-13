# redline — Delivery Plan (live)

> **Status:** the live tracking document.
>
> **This tracks outstanding work only. It does not restate design.**
> [`architecture.md`](./architecture.md) is what redline *is*;
> [`design-principles.md`](./design-principles.md) holds the durable principles
> and non-goals. Completed work and the reasoning behind superseded plans live in
> git history, not here. Item numbers are local to this file and are renumbered
> whenever the outstanding set changes.
>
> **Do not cross-reference sections of this file, and do not cite its item
> numbers — from here, from the other documents, or from source comments.** The
> numbering changes every time the outstanding set does, so every such reference
> is wrong shortly after it is written, and cleaning them up has repeatedly cost
> more than they ever saved. State the substance, or cite `architecture.md`,
> which is stable.
>
> **A corpus is input, never a premise.** redline is built for arbitrary
> procurement corpora. Running one corpus produces *measurements* — a rule that
> did not fire, a vocabulary that was never reached, an extraction path that was
> never taken. A measurement may falsify something. It may never become a scope
> decision, a design constraint, or a justification inside a general code path.
> When recording a run finding, name the corpus, say what it showed, and say what
> would validate the untested case.
>
> **Availability of a data source is a runtime condition, not a design input.**
> Whether the enrich graph is loaded, or a similarity index exists, does not
> decide which tools redline builds. Build the surface; return unavailable when
> the data is not there; fail loudly and legibly when the task cannot be
> completed. Never scope a capability out because a config flag is currently off.

---

## 1. The build-step contract

- One build step including its test. If the exit test needs two unrelated things
  built first, it is two steps.
- One agent, one context. One commit. A PR only on explicit request.
- Tests-first: the test file is written before the implementation file.
- One package where possible.
- **A fork-side step is two commits, not one.** Work in `services/wayfinder`
  lands on the fork's `main` there, then needs the gitlink *and*
  `wayfinder.pin`'s `ref` moved here in step. Letting those two drift is what
  left redline typechecking against a domain package the fork had moved past.
  **The order is forced, not stylistic:** `validate.sh` #15 fails unless the
  submodule sits on the fork `main`'s commit, so a fork feature branch
  cannot be pinned — it must merge there first. Plan the fork PR as part of the
  step, or the second commit cannot be made.

---

## 2. The lean vertical

**Goal: a procurement corpus goes in, and a specialist gets a report out —
delineated by topic and brand, with provenance back to source.** The
comprehension-lens work and the trained-classifier overlay are deferred to
housekeeping.

**The report is the product, not the grid.** A corpus that is merely extracted,
chunked and classified is womblex plus a classifier; almost none of that needs
redline. What redline is for is the step after — assembling those addressable,
provenance-tagged facts into something a procurement specialist hands to a
delegate.

**Numbatch is not on this path.** Classification runs cold-start over womblex
extraction: hard rules + LLM adjudication navigating the store's
chunks/provenance. Financial facts come from womblex's own value-typed table
cells / money sidecars. The Numbatch stack re-enters only when a *trained*
overlay or the financial extension's roll-up is wanted; neither is needed to see
the grid.

**"Pricing" is the wrong word for this layer, and using it has already cost us.**
What womblex lands is *financial expressions* — value-typed spans with a currency,
a magnitude and provenance. A price is one reading of one of those. The store and
the ports underneath must carry the general thing; interpretation (which
requirement it belongs to, what it rolls up to, whether it is a price at all) is a
consumer's job and belongs above them. The alternative — a bespoke path per
financial-data type — is a build with no end. The money-span store is built
against that rule, and `MoneySpanFinancialExtractor`'s contract (one AUD figure
per (document, requirement)) is one reading above it — a narrowing to hold at
arm's length rather than entrench.

**The browser now starts a run, but it does not yet finish one.** The served
Create Corpus tab creates the evaluation and fires the womblex run, and the
tracker follows that run to `done` — so the engine half is no longer terminal-only.
redline's *own* post-run sequence is: `IngestDocuments`,
`AssignDocumentsToGroups`, the cold-start classifier and `BuildEvaluationTable`
are built and wired in `container-redline.ts`, but no served route calls them.
`resolveRedlineSeedDependencies` hands them to
`apps/web/scripts/seed-redline-evaluation.ts`, which remains the only path that
runs them. A specialist who follows "Open the evaluation" today therefore lands
on an evaluation with documents and no responses: `openReviewGrid` and
`openPricingPivot` both read persisted responses and neither builds them. Closing
that is the outstanding half of the programme below; the reasoning for retiring
the old descope is under "Superseded decisions."

**The fixture corpus is a test fixture and will grow heterogeneous.** It is not
what redline is built against and it is not a scope boundary. Documents that are
not tender responses — an annual report, a policy, a standard — must flow through
the same path without special handling: they classify against whatever topics the
lens carries, and a document that addresses none surfaces as a row with a null
requirement and an `addressed_nothing` reason. Nothing may infer a document's
kind from its name or assume every document answers something. Where a
tender-shaped assumption is found, it is a defect.

**The report work is not gated on a pipeline run, and treating it as though it
were is a planning error we have already made once.** The report seam needs *rows
in the store* — chunks, spans, responses with provenance — not a live
extract→classify→build sequence that produced them, and the sheet builder needs
only an assembled report as data. Those rows can be seeded straight into
Postgres, which is how `packages/redline-adapters`' own suite already works
(PGlite, seeded rows, no services).

---

## 2.1 The Create Corpus programme (next priority)

**Goal: a specialist starts a corpus from the browser — uploads raw documents,
authors the run config, triggers the womblex run, watches it drain, and then
composes an evaluation over the result — with no terminal in the loop.** An
operator at a terminal is not a delivery mechanism for the specialists who use
this, so the run descope is retired (see "Superseded decisions") and the work
below is planned rather than merely costed.

**Cold start is the case, not a variant of it.** The goal above once read as one
screen that named the evaluation *and* fired the run; building it that way is
what produced a surface that can only re-run a corpus something else already
extracted. Raw documents in, evaluation out — in that order, across two screens —
is the shape. See "Cold start" below.

**This makes redline trigger and track a womblex run, which it did not before.**
Until now object storage was the only seam to the engine — redline wrote shards'
prefix and read them back, and the engine's batching, retry and scale-out were
its own, driven from the compose profiles. A browser "start run" button adds a
*second* seam: a trigger into the engine's job queue and a read of its state.
That is a real change to what redline is; `architecture.md` (§3/§5) is amended to
record the new engine seam **as each part is built**, not ahead of it — the
engine seam stops being object-storage-only when the code that adds the second
one lands. What does **not** change: redline still does not reimplement batching,
retry or scale-out — those stay the engine's (`cloud/worker.py`, its Postgres
queue). redline drives and observes; it does not wrap.

**What is a specialist's to configure, and what is not — this is load-bearing.**
The surface exposes **corpus composition** (which documents, the evaluation's
name/id), reuses the existing create surface's **lens and grouping** (topics,
definitions, brands — already `CreateEvaluation`'s inputs), and **may author a
per-run override of the womblex config** over `infra/womblex/redline.yaml` as the
default layer — a blank field inherits the default we defined. The overridable
set is a **defined allow-list**, not the whole file: the run parameters that
plausibly differ as corpus nature changes — the **stage sequence** (which of
chunk/embed/enrich/money run, in what order), the **chunk mode**
(`chunking.chunking_model` null for offline token chunking vs set for AI/semantic
chunking, plus `chunk_size` / `chunk_tables`), and the **money vocabulary**
(`money.columns.extra_header_terms` / `money.columns.extra_veto_terms` and
`money.default_currency` — the two term lists hang off `MoneyColumnsConfig`, not
off `MoneyConfig`, which is where a merge written from the short names would put
them). What stays
fixed in the file regardless of what a form submits: the **structural / identity
keys** — the embed model and `task`, the OCR `engine`, `enrichment.enabled` where
the report graph depends on it, the Isaacus gate. Changing one of those does not
tune a run, it silently orphans the vectors, deletes table cells, or empties the
graph — a break that surfaces stages later as an empty grid. The allow-list is
the safety; the override layer is the mechanism. Recorded as a durable decision
in `design-principles.md`.

The programme is a set of build steps, each tests-first, in dependency order. The
fork-side ones are two commits (the build-step contract's fork rule). Ordering
between them is real: a step cannot use a seam an earlier step has not built.

The object-store write port at the head of this programme is built:
`IStagedCorpusWriter` / `MinioStagedCorpusWriter` stages a specialist's chosen
bytes under `proc/{evaluationId}/inputs/` (the prefix the engine's runner reads
its input from). It stages bytes only — womblex mints the `source_hash`
identities on extract — and the **list/browse** half (raw objects womblex has
not processed yet) is deferred with the document-selection work below.

The run trigger + run-status seam is built: `IWomblexRunTrigger` /
`HttpWomblexRunTrigger` (redline-adapters) over the sidecar's `POST /runs` /
`GET /runs/{runId}` / `POST /runs/{runId}/resume`, and the sidecar's
`run_trigger.py` behind them — the thin runner that fires the fixed CLI sequence
(extraction `worker`, then `run-stage --stage {chunk,embed,enrich,money}` in the
caller-authored order, dependency-normalised) against the UI-authored config,
layering the current downstream stage over `womblex_jobs` for status. Resume
re-fires the same run (idempotent enqueue + skip-on-output). `architecture.md`
§3/§5 records the second engine seam.

The run-status view model + controller is built: `renderRunStatusView` /
`RunStatusController` (redline-web) over that status seam. The view model is a
pure `RunStatusView` → presentation transform the served route binds to,
reducing a minutes-long run to the four states the surface must show — **started**
(running), **errored** (which stage, and why), **resumable**, **done** — and
owning `shouldKeepPolling` so a failed stage names itself and offers resume
rather than spinning forever. The controller drives the seam (start, poll into
the view model, resume by re-firing the same trigger) and returns seam errors as
`Result`s rather than throwing across the boundary. Polled, not streamed.

The surface and its fork mount are built: `renderCreateCorpusView` /
`CreateCorpusController` (redline-web) own the readiness rule and the write
seams, and `johntooth/wayfinder`'s standalone `/create-corpus` tab binds them —
the staged-corpus picker, the name field, documents-and-brands, the fields, the
stage sequence, the allow-listed override editors and the run tracker — behind
`evaluation:create` on the route, the procedures and the sidebar entry alike.
`docs/guides/create-a-corpus.md` is the user-facing description of what it does.

**The surface was built around the wrong case, and that is the finding to act on
before anything below it.** womblex is a cold-start engine: `womblex run` and the
cloud path both take *raw documents* from an input prefix and produce shards, and
`_engine_enqueue` reads exactly `proc/{evaluationId}/inputs`, refusing an empty
prefix with "stage the corpus before triggering a run". Cold start is the case
the engine is designed around and the case redline exists to serve. The Create
Corpus tab cannot do it — not because a seam is missing, but because of one
self-inflicted coupling described under "Cold start" below. Every part it needs
is already built. The remaining work is therefore smaller than the table below
first suggests, and part of it is deletion.

### Cold start — the coupling to remove

**One line of ordering is what blocks the case the whole programme is for.** The
Create Corpus tab calls `CreateEvaluation` and *then* `startRun`. An evaluation
is composed from document ids, and a redline document id is womblex's
`source_hash` — minted during extraction. So the surface asks a specialist to
name brands and fields for documents that do not have identities yet, and
`CreateEvaluation.assertDocumentsStaged` then refuses every one of them because
`DrizzleStagedCorpusReader` lists only what the sidecar's load path has already
written to `redline_chunks`. A corpus therefore has to be extracted before it can
be started, which is a contradiction rather than a limitation.

**The design already knew these were two jobs.** The fork's own route comment
says it plainly — a standalone tab rather than a change to `/evaluations/new`,
because "ingest and evaluation are different users". The tab then made one
person do both jobs in one submit, and inherited the second job's prerequisite.

**Splitting them back apart removes code.** Create Corpus becomes what the user
frustration correctly describes — a screen over the engine's config and CLI:
name the corpus, upload the documents, author the config, pick the stages, fire,
watch. No brands, no fields, no `CreateEvaluation` call, no `ALREADY_EXISTS`
case, and no chicken-and-egg, because nothing on that screen needs a
`source_hash`. When the run lands, `redline_chunks` is populated and
`/evaluations/new` — which already assumes an extracted corpus and already works
— composes the evaluation as originally intended. The brand/field half of the
Create Corpus form is then duplicated logic to delete, not to fix.

**Nothing new has to be built for the upload.** `MinioStagedCorpusWriter` writes
to `proc/{evaluationId}/inputs/`, which is byte-for-byte the prefix
`_engine_enqueue` lists. The fork already ships a browser upload of exactly this
shape — `extraction.uploadDraftDocuments` takes file bytes through a tRPC
procedure into `objectStorage.put`, with progressive auto-save and archive
handling. "Upload transport (through the app vs presigned direct-to-bucket)" is
recorded above as an open decision; the fork settled it in practice, and the
staged path can follow it rather than reopen it.

**The corpus id stops being a trap on this screen.** The "pick, never type" rule
exists because an evaluation's id must equal an existing corpus's id. When the
screen's job is to *create* the corpus, naming it is the natural act and there is
nothing yet to mismatch — the collision check moves to "does this corpus id
already exist", which is a plain existence check rather than an invariant.

**The allow-list was drawn for the wrong case too.** Its rationale is that
changing a structural key "silently orphans the vectors, deletes table cells, or
empties the graph" — every one of which is a *re-run* hazard, where prior outputs
exist to be orphaned. On a first run there is nothing to orphan. Cold start also
needs more of the config than a re-run does: `redline.yaml` marks
`extraction.ocr.engine: paddleocr` LOAD-BEARING because switching to a VLM engine
deletes every table cell on a scanned page, and scanned tenders are exactly what
a first run meets. So the authorable set should be *wider* on a first run than on
a re-run, and the current allow-list is the re-run one. Widening it is a decision
to take deliberately, not a licence to expose the file wholesale.

| Step | Package(s) | What it is |
|---|---|---|
| Create Corpus becomes an ingest surface | redline-web + wayfinder (two commits) | Drop the brand/field half and the `CreateEvaluation` call from the tab; add the corpus name and the document upload over the built `IStagedCorpusWriter`, following the fork's existing upload procedure shape. On `done` the tracker links to `/evaluations/new` rather than to an evaluation. _Exit: `redline-create-corpus.spec.ts` uploads a document to a corpus id no run has used, fires the run, and the corpus appears in `/evaluations/new`'s picker when it settles._ |
| Widen the authorable config for a first run | domain + womblex-ingest | Decide which further keys a *first* run may author (the OCR engine and extraction settings are the candidates that matter; the embed model and task stay fixed because the retrieval pairing is not a per-corpus choice) and carry them through the same override shape. _Exit: a first run authored with a non-default OCR engine extracts against that engine, and a re-run over a corpus with existing shards still refuses it._ |

With the split, the post-run population steps below stop being about Create
Corpus at all: they belong to `/evaluations/new`, which is where an evaluation is
composed, and they run when the specialist creates it over an extracted corpus.

**The allow-listed override is authored but never applied.** The form composes it,
`makeRunConfigOverride` validates it, and `HttpWomblexRunTrigger` puts it on the
wire — then the sidecar drops it. `TriggerRunRequest` in
`services/womblex-ingest/src/womblex_ingest/main.py` declares only `evaluationId`
and `stageSequence`, and `RunPlan` carries the same two, so pydantic discards the
extra key without complaint and every run uses the `redline.yaml` default. The
allow-list is decided and built; only its last leg is missing. Silently ignoring
an override a specialist typed is worse than refusing it, so this is a defect in
the seam rather than a deferral.

The one group to think twice about before wiring is `chunking_model`. Setting it
switches chunking from the vendored offline tokeniser to a per-document Isaacus
call, and `WomblexConfig._wire_ai_chunking_reuse` then auto-enables
`enrichment.persist_document` and warns that `enrich` must run *before* `chunk`
or the document is enriched twice — at double cost. The Create Corpus stage
toggles cannot express that ordering (the sidecar normalises chunk before embed
and leaves enrich where it was authored), so a specialist ticking an AI model
would buy an API bill from a checkbox with no way to avoid the double charge.
Either carry only `chunk_size` / `chunk_tables` in the wire shape, or make the
ordering the model implies part of what the override sets.

**Nothing runs redline's own passes when the engine's finish.** The tracker's
"Open the evaluation" is the end of the served path; `IngestDocuments`, grouping,
classification and `BuildEvaluationTable` still only run from the seed script, so
the grid and pivots read an empty response set. This is the seed script's second
half, and it is two steps because the fork rule makes it two commits anyway.

| Step | Package(s) | What it is |
|---|---|---|
| Apply the run-config override below the seam | womblex-ingest | `TriggerRunRequest` and `RunPlan` accept the allow-listed `configOverride`, and the runner layers it over `redline.yaml` before firing the passes. The groups are the ones already decided (chunk mode, money vocabulary); the fixed structural keys stay unreachable because the shape cannot express them. _Exit: a `POST /runs` carrying a chunk-mode and money-vocabulary override fires its stage sequence against a config whose `chunk_size` and `default_currency` are the request's, not the file's._ |
| Post-run population, brains half | redline-web | A controller method that takes a settled evaluation through the sequence the seed script drives — `IngestDocuments`, then `openWorkflow` → `advance` → `buildTable` — returning `Result`s and re-runnable over an evaluation already populated (a resumed run must not double-write responses). _Exit: over a fake extraction reader and an in-memory repository, running it against an evaluation with staged documents and no responses leaves the response set the review grid reads, and running it a second time leaves the same set rather than a doubled one._ |
| Post-run population, fork mount | wayfinder (two commits) | The tRPC procedure behind `evaluation:create` and the tracker calling it when the run reaches `done`, so "Open the evaluation" lands on a populated grid. The failure needs its own state — population failing after a successful engine run is not the same thing as a failed stage, and must not present as one. _Exit: `redline-create-corpus.spec.ts`'s live test reaches the review grid with rows, rather than an evaluation with documents and none._ |

**The fork gitlink and `wayfinder.pin` have not been moved.** The build-step
contract's fork rule wants both moved in step with the fork commit; today
`services/wayfinder` records `f32ebc4` and `wayfinder.pin`'s `ref` is `8c9d9b8`,
while the fork's `main` is at `06f0b76` (the Create Corpus mount). The two
disagree with each other as well as with the fork, which is the exact drift the
rule exists to prevent. `validate.sh` #15 catches the gitlink half of it — but
only on a checkout where the fork's branch ref resolves; it skips on a clone with
no submodule (this one) and on the shallow checkout that carries no branch refs,
which is why the drift has gone unnoticed. Nothing checks `wayfinder.pin`'s `ref`
against the gitlink at all. Moving both is not a build step and needs no test of
its own; do it with the next fork-side commit at the latest.

**The synthesis document-picker is deferred with the document-selection half.**
UAT also asked that Wayfinder's own "Synthesise Information" flow let a user
select documents from a bucket or an existing corpus rather than only upload.
That is normal work on `johntooth/wayfinder` (redline's own fork — the old
"upstream, do not touch" framing was wrong; there is no clean-diff relationship to
rbrasier left to protect, and `validate.sh` #15 only enforces the checkout sits
on the fork's `main`). When it lands, the **leaner change is "from a corpus"** —
it reuses the `IStagedCorpusReader` this programme already leans on, over
documents that already carry stable `source_hash` identities; "from the raw
bucket" waits on the browse half. The one caution is the fork rule: a change
touching `@rbrasier/domain` brings the contract test and pin bump in step.

**The womblex-surface decisions are settled; the document-selection half is
deferred.** How redline drives and watches the run is decided:

- **Trigger is a thin runner, not an orchestrator.** womblex's stages are already
  composable, config-based CLI passes (`worker` for extraction, then `run-stage
  --stage {chunk,embed,enrich}`, then `money`). Triggering a run is firing that
  fixed sequence in order for one evaluation — the exact thing the seed script's
  operator does by hand — against the config the UI authored (allow-list override
  over `redline.yaml`). Batching, retry and scale-out stay inside each pass
  (`cloud/worker.py`, the queue); redline does not reimplement them. "Drives and
  observes, does not wrap" holds.
- **The sidecar owns trigger and status.** The `womblex-ingest` world already
  runs the money stage in Python against the engine installed from the submodule
  source (the `money` compose image), so firing the CLI sequence is Python's job
  there, not TypeScript's — and it keeps the queue-schema knowledge out of
  redline. redline calls two JSON endpoints: run this
  evaluation's pipeline, and status of this run. Reading womblex's `womblex_jobs`
  table directly from TypeScript was the alternative (fewer parts, but couples
  redline to an engine-owned schema on an untagged pin); rejected for the sidecar.
- **Status is polled, not streamed** — a run is minutes-long and changes state
  coarsely, so a tRPC query on an interval is leaner than SSE and enough. The
  surface must show four things: **started** (queue has pending/running rows),
  **errored** (a batch exhausted `max_attempts`; the row's `error` says why, and
  the trigger reports which *stage* of the sequence failed — `womblex_jobs` tracks
  extraction batches only, so the sidecar layers the current stage on top),
  **resumable** (womblex's `enqueue` is idempotent on `(run_id, batch_num)` and
  `requeue_stale` recovers crashed workers, so **resume is re-firing the same
  trigger** — done batches skip, work picks up where it stopped; redline builds no
  resume logic of its own), and **done** (all batches `done`, all stages run).
- **The surface is a standalone tab in Wayfinder**, gated on `evaluation:create`,
  not a change to `/evaluations/new` — ingest and evaluation are different users,
  so the existing create flow's "corpus already staged" assumption and its
  `ALREADY_EXISTS` behaviour stay untouched.

**Deferred (the document-selection half).** Whether the picker browses raw bucket
objects vs staged corpora, and how bytes are uploaded (through the app vs
presigned direct-to-bucket), are held for now — the run surface above is built
first, over the staged path the existing `IStagedCorpusReader` already serves.

---

## 3. Housekeeping — off the vertical, wanted before users

Deferred until the lean vertical is complete. In dependency order:

| Item | Package(s) | Notes |
|---|---|---|
| Hard-rule authoring for prose | domain | The mechanism cannot express what specialists want to match. `evaluateHardRules` matches identifier-shaped tokens; a rule authored as a body-text phrase is now a loud authoring error rather than a silent miss, which is honest but leaves the need unmet. Decide what a specialist authors when the thing to match is prose. |
| Collision selection, ordering & capping | domain | Bounded, deterministic selection of genuinely ambiguous documents. |
| `BoundaryDecision` entity | domain | Net-new modelling. Owns primary/secondary semantics. |
| Decision persistence + corrections push | adapters | Shrunk: upstream owns corrections + audit — an adapter call over an existing API, not a build. |
| Lens persistence | adapters | Shrunk: the classification-side tables are built. What remains: the lens's Numbatch bindings (references, not copies), the authoring surface, and the durable-asset surface. |
| Lens portability | application | Apply a saved lens to a different corpus; its boundary decisions still bite. |
| Lens stage machine | redline-web | Define → map → resolve → save, its own machine. |
| Collision resolution surface | redline-web | View model + controller for resolving a collision set. |
| Sample accrual | adapters | Shrunk: upstream topic-scoped dedupe indexes give re-push idempotence for free. |
| Train/activate policy | adapters | Needs redesign — auto-activation contradicts upstream ADR-0021 (activation is a user-controlled pointer move with a replay diff). Surface the upstream flow: auto-*train* on crossing the floor, then let the specialist activate. |
| Workspace extraction & release prep | workspace | Standalone workspace; sever the vendoring seam; graft the financial overlay onto the fork. Last by nature. |

---

## 4. Open questions

1. **Still owned here:** tenancy mapping — Numbatch `organisation_id` ↔ Wayfinder
   identity (settle before a lens is shared between users); primary/secondary
   semantics (Numbatch returns score-sorted ≤3 topics with no primary/secondary
   distinction; owned by `BoundaryDecision`); ambiguity thresholds — the signal
   register needs initial values, and they are a design choice to be reasoned
   about and then tuned, not something one corpus can hand us. **What a report
   is** was on this list by omission — five source comments assigned work to a
   "report-assembler LLM" that appeared in no document and no item. That
   assembler now has hands (`apps/redline-mcp`, including graph traversal), and
   the definition is now **settled in `architecture.md` §5.1** — no longer open.

2. **Raw-corpus intake has two paths; the direct one exists and the UI write path
   is now planned.** Direct-to-bucket works now: an S3 client (`mc cp`, or any
   uploader) writes the raw documents under `proc/{evaluationId}/` in redline's
   bucket — the seam is plain S3, redline builds nothing for it, and the path is
   documented in `docs/guides/two-stack-local-run.md`. The **via-UI write** path is
   built (`IStagedCorpusWriter`); the **browse/select** half (listing raw objects
   to pick from) is deferred with the document-selection work. Both paths stage
   bytes only — womblex then processes the corpus and mints the `source_hash`
   identities the evaluation references, which is why
   `redline-create-evaluation.spec.ts` gates on an `E2E_REDLINE_STAGED_CORPUS_ID`
   naming a corpus **no evaluation has claimed** (`create` refuses a claimed one
   with `ALREADY_EXISTS`).

3. **The Playwright specs that need a populated evaluation are run later, and that
   is deliberate.** They prove the *served DOM* the view models bind to; the view
   models and builders are already proven framework-free in the `redline-web` and
   `redline-adapters` vitest suites, so no build step is gated on these specs.
   Running them needs an `E2E_REDLINE_EVALUATION_ID`, a runner that has
   Playwright, and a web container that is not the pruned production install (no
   dev dependencies, no browsers). Scheduling that environment is not a
   lean-vertical concern.

4. **A lens is declared at create time, not authored.** The create screen's
   fields become the lens's topics, so the manifest is gone — but the lens is
   written once, with **no hard rules**, because a specialist typing field names
   supplies no patterns to author rules from. Nothing edits a lens after the
   fact, and there is no versioning or durable-asset lifecycle; that surface is
   housekeeping. The seed script still writes rules from a manifest, and is now
   the only path that can.

5. **A range inside a pricing *table* is still uncountable, and that is
   upstream's.** The grid's reading counts a range once at its upper endpoint
   (`readDocumentMoney`), but it can only see a range womblex grouped — and
   `money_stage.py`'s `_cell_row` attaches no `range_group`/`range_role` to cell
   spans at all, so "$1M–$2M" written in a pricing schedule arrives as two
   ungrouped rows and is counted twice. Narrative ranges are handled. Re-checked
   against womblex 0.4.0 (`d6850de`, the narrative-money release): `_cell_row`
   still neither accepts nor sets those fields, so the bump does not close this.
   Fixing it properly is a womblex change, not a redline one; raise it upstream
   rather than inferring a grouping here from adjacency.

6. **Source comments cite ADR numbers, none of which resolve.** Plan item
   citations are gone from source — do not reintroduce them. What remains is
   `ADR-00xx`, densely, across `packages/`, `apps/`, `infra/`, `scripts/` and
   `validate.sh`. Harmless where the comment states its own substance, which is
   the common case; fix opportunistically when touching the file rather than as a
   pass of its own. `grep -rn 'ADR-00' packages apps services infra scripts` is
   the live answer; a count here would rot like everything else. Read a surviving
   number as a pointer into git history, except where it is plainly upstream's —
   Wayfinder's, Numbatch's and womblex's own registers do still exist, which is
   why the train/activate row above cites *upstream* ADR-0021 and means a
   different document from anything redline ever wrote.

   **Settled: ADRs stay abandoned.** Four were written after the deletion
   (0008, 0018, 0019, 0021) and have been removed; `.claude/CLAUDE.md` and
   `design-principles.md` were right and stand unchanged. Where a deleted ADR
   carried something the prose did not, that substance was written into
   `architecture.md` instead — the untagged womblex pin's justification is under
   "Vendoring / pinning discipline". Decisions are recorded in the commit that
   acts on them; a decision durable enough to govern many commits goes to
   `design-principles.md`. Do not open `docs/adr/` again.

---

## 5. Sequencing

**The order is: lean vertical (done) → Create Corpus programme → housekeeping in
dependency order → workspace extraction and release.**

The Create Corpus programme's steps have their own internal ordering, and **cold
start leads**. Splitting the tab back into an ingest surface comes first: it is
the case the engine is built for, it unblocks every other step's ability to be
tested over a corpus the browser made, and it removes the brand/field duplication
rather than adding to it. The override step follows (it is what makes that
surface worth having). The post-run population pair then lands against
`/evaluations/new` rather than Create Corpus, in its own order — brains, then the
fork mount that calls them. Raw-bucket *browse* and the synthesis picker stay
deferred; upload transport does not, because the ingest surface needs it and the
fork already settled the shape.

### Superseded decisions

- **Browser-driven run was descoped (2026-08-09), and that is retired
  (UAT).** The descope read: running a corpus from the browser is out of scope,
  not deferred — nothing planned it, and every evaluation begins with an operator
  at a terminal driving `seed-redline-evaluation.ts`. Its stated cost was the
  unwritten seams (an object-store port, a run trigger/status seam) and the
  "redline does not wrap the engine" posture. **UAT falsified the premise**: a
  terminal is not a delivery mechanism for the specialists who use this. The
  Create Corpus programme now plans those seams (the write + run seams first, the
  browse/select half deferred). The posture is amended rather than discarded —
  redline *drives and observes* the engine's run but still does not reimplement
  its batching, retry or scale-out; `architecture.md` §3/§5 is updated to record
  that as the seam is built, not ahead of it.

- **"The Wayfinder fork is upstream, do not modify" was never the rule, and the
  earlier framing of it was wrong.** redline builds and runs against
  `johntooth/wayfinder` — its own fork — on branch `main`. The clean-upstreaming-
  diff guard that once justified treating the fork as read-only was deliberately
  removed from `validate.sh` #15 ("policed a relationship we do not have").
  Modifying the fork's own features (e.g. the synthesis document source) is
  ordinary fork work under the two-commit rule; the only live caution is that a
  change to `@rbrasier/domain`'s shape brings the contract test and
  `wayfinder.pin` bump in step.

### What the lean vertical deliberately does not do

- **No trained classifier, no samples, no adapter.** The untrained first pass only.
- **No Numbatch stack.** Re-enters when a trained overlay or the financial
  extension's roll-up is wanted.
- **No comprehension lens.** Collisions, boundary decisions, lens authoring and
  portability all wait.
- **No vector *similarity search*.** The `pgvector`/ANN *index*, `findSimilar` and
  the store-side query-embed path are deferred. The embeddings *are* loaded and
  available; what waits is the nearest-neighbour index over them. Per the runtime
  rule above, this defers an index — it does not shrink the tool surface built
  over retrieval.
- **No workspace extraction.** Ship-shape is a later concern than see-shape.

`linking` stays off deliberately and is not the same thing as enrichment: `link`
writes `*.entity_links.parquet`, which nothing in redline reads, and its preflight
hard-fails without a `linking.reference` register a tender corpus has no candidate
for. Enrichment itself is **on**.
