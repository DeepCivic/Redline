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

## 2. The lean vertical (current priority)

**Goal: a procurement corpus goes in, and a specialist gets a report out —
delineated by topic and brand, with provenance back to source.** The
comprehension-lens work and the trained-classifier overlay are deferred to
housekeeping.

**The report is the product, not the grid.** A corpus that is merely extracted,
chunked and classified is womblex plus a classifier; almost none of that needs
redline. What redline is for is the step after — assembling those addressable,
provenance-tagged facts into something a procurement specialist hands to a
delegate. The report tool surface that gives an assembler hands is built, QA'd
and registered in Wayfinder (`apps/redline-mcp`) — the deterministic
chunk/money/extraction fetches **and** graph traversal, ten tools served, its
byte-identity and `graphAvailable` cases proven under the gate — and **what a
report is** is settled in `architecture.md` §5.1. **The assembly loop that turns
that surface into a report is built** (fork-side, `ReportAssembler` in
`@rbrasier/adapters`): it gathers over the tools, assembles ordered sections of
model-chosen prose with verbatim cited passages, and asserts every transferred
passage byte-identical against the store — the no-graph case returning a reported
unavailability rather than a thinner report, all proven under the gate. **The
seam that turns an assembled report into the sheet a specialist receives is now
built too** (`report-export.ts` in `apps/redline-web`): `buildReportSheetData` /
`buildReportWorkbook` render an assembled report deterministically to a workbook
through the existing `write-excel-file` writer, with every citation intact,
proven by a builder test over a fixed report structure. The lean vertical is
therefore feature-complete; **UAT can start**.

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

The read path is built and merged end to end — store-backed classifier, money
extractor, the served fork, the persisted lens, the `/evaluations` index and the
document route. **Creating** an evaluation is a browser action too: the
`evaluation` router's `create` mutation over a picked staged corpus, gated on its
own `evaluation:create` permission.

**The run is on the script today, and a browser-driven run is now the next
priority (the Create Corpus programme below).** `IngestDocuments`,
`AssignDocumentsToGroups`, the cold-start classifier and `BuildEvaluationTable`
are all built and wired in `container-redline.ts`, but nothing served calls them —
`apps/web/scripts/seed-redline-evaluation.ts` drives the pipeline from a terminal
and remains the only path that does. UAT begins on that footing: an operator
with a terminal stages the corpus and starts the run, and the specialist's
browser surface begins at the populated evaluation. **That the run was out of
scope is no longer true** — UAT showed a specialist cannot be handed a terminal,
so the Create Corpus programme (below) brings staging, the run and its progress
into the browser. The old descope is retired; the reasoning is under
"Superseded decisions" below.

**The pipeline has run end to end.** A fixture run over `cloud-rft-2026` (4
documents) took extraction through chunk → embed → enrich → money and landed 133
entities, 1,771 graph edges and 65 money spans. That proves the connectors and
the shard path. It proves nothing about report quality, and its per-corpus
findings are recorded at the sites they bear on, not here.

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
only an assembled report as data (a fixture-shaped one or the loop's output).
Those rows can be seeded straight into Postgres, which is how
`packages/redline-adapters`' own suite already works (PGlite, seeded rows, no
services).

**The report-side work is complete.** The workbook builder
(`buildEvaluationWorkbook`) and the report sheet seam (`buildReportSheetData` /
`buildReportWorkbook`, `report-export.ts`) both live in `apps/redline-web`. The
report tool surface the assembler calls, and the assembly loop itself, are both
built: the surface is served over a URL the fork registers rather than imports
(`apps/redline-mcp`), and the loop is fork-side in `@rbrasier/adapters`, so its
landing was two commits (the feature on the fork's `main`, then the gitlink and
pin moved here in step).

---

## 2.1 The Create Corpus programme (next priority)

**Goal: a specialist starts a corpus from the browser — picks documents, names
the evaluation, triggers the womblex run, watches it drain, and lands on a
populated evaluation — with no terminal in the loop.** This is the capability UAT
showed is required: an operator at a terminal is not a delivery mechanism, so the
run descope is retired (see "Superseded decisions") and the work below is planned
rather than merely costed.

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
name/id) and reuses the existing create surface's **lens and grouping** (topics,
definitions, brands — already `CreateEvaluation`'s inputs). It exposes **none of
the engine's stage tuning**: chunk size, the money vocabulary/vetoes, the OCR
engine, `enrichment.enabled` and the Isaacus gate all stay in
`infra/womblex/redline.yaml`, where each carries a load-bearing comment earned by
measurement or an upstream constraint. Those are engineering decisions, not
specialist ones — a user toggling `enrichment.enabled` or `chunk_size` silently
breaks retrieval or the graph the report assembler navigates. Surfacing engine
config as UI knobs is a non-goal, now recorded in `design-principles.md`.

The programme is a set of build steps, each tests-first, in dependency order. The
fork-side ones are two commits (the build-step contract's fork rule). Ordering
between them is real: a step cannot use a seam an earlier step has not built.

| Step | Package(s) | What it is |
|---|---|---|
| Object-store write + browse port | domain + adapters | redline's first write-side and list-side object-store port — every existing domain port is a read surface. Lists raw objects under a bucket prefix (so the picker can show documents womblex has **not** processed yet, before any `source_hash`/chunk identity exists) and stages uploaded/selected bytes under `proc/{evaluationId}/`. The seam stays plain S3 (redline owns its bucket); the adapter is the only code at it. Folds in what was the "corpus upload via UI" housekeeping item — upload is one caller of this port. |
| Run trigger + run-status seam | adapters (+ sidecar) | The second engine seam. A trigger that enqueues an evaluation's documents for extraction and sequences the ordered downstream passes (chunk → embed → enrich, then `money` once the fleet drains), and a **read** of run state so the browser can report progress. **Open design question below** decides whether redline reads/writes womblex's `womblex_jobs` queue directly or the `womblex-ingest` sidecar fronts it — do not build until settled. The ordering of the passes is not the specialist's to get right; it is this seam's. |
| Run-status view model + controller | redline-web | Framework-free: a run's state (queued / extracting / staging chunk… / draining money / ready / failed) as a pure view model the served route binds to, over the status seam. A run that fails a stage surfaces which stage and why, not a spinner that never resolves. |
| Create Corpus surface | redline-web | The document picker (from a **staged corpus** via the existing `IStagedCorpusReader`, or from **raw bucket objects** via the new browse port — lead with the staged path, it reuses a built port), the evaluation name/id field, and the trigger. On completion it drives the already-built ingest → lens → grouping → build sequence — the seed script's middle, minus the manifest. |
| Fork mount: route + procedure + gate | wayfinder (two commits) | The served `/evaluations/new`-adjacent surface in `johntooth/wayfinder`, its tRPC procedures (trigger, poll status) behind `evaluation:create`, and the sidebar entry. Same shape as the existing evaluation mount. If it touches `@rbrasier/domain`, the contract test and `wayfinder.pin` bump come in step. |

**The synthesis document-picker rides on this, it does not fork off it.** UAT also
asked that Wayfinder's own "Synthesise Information" flow let a user select
documents from a bucket or an existing corpus rather than only upload. That is
normal work on `johntooth/wayfinder` (redline's own fork — the old
"upstream, do not touch" framing was wrong; there is no clean-diff relationship to
rbrasier left to protect, and `validate.sh` #15 only enforces the checkout sits
on the fork's `main`). The **leaner change is "from a corpus"**: it reuses the
`IStagedCorpusReader` this programme already leans on, over documents that
already carry stable `source_hash` identities. "From the raw bucket" needs the
browse port above, so it is not additional work once that port exists — build
the corpus path first, add the raw-bucket path behind the same port. The one
caution is the fork rule: a change touching `@rbrasier/domain` brings the
contract test and pin bump in step.

**Open design question, settle before the run-trigger step.** Does redline drive
womblex's job queue **directly** (redline reads/writes `womblex_jobs`, coupling
it to the engine's queue schema), or through a **thin new endpoint on the
`womblex-ingest` sidecar** that fronts the queue (keeping "the sidecar is the
only Python redline talks to" shape, at the cost of a new sidecar surface)? The
sidecar-fronted option preserves the existing seam discipline and is the
provisional lean; the direct option is fewer moving parts but a schema coupling
to an engine redline pins rather than owns. This is a design choice to reason
about, not something a corpus decides — record the outcome in `architecture.md`
when made.

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

2. **The browser-driven run is planned, not descoped — see the Create Corpus
   programme.** Choosing which documents are in scope for an evaluation, staging
   them, starting the pipeline and tracking it was descoped on 2026-08-09 as "out
   of scope, not deferred-and-scheduled." **UAT reversed that**: a specialist
   cannot be handed a terminal, so the capability is now the next priority. The
   reversal and what it changed (a second engine seam, the object-store write
   port) are the programme's own concern; the retired reasoning is under
   "Superseded decisions." The `evaluation` router's `create` mutation is
   unchanged — it still creates an evaluation over a staged corpus; the programme
   adds the staging and the run *before* it.

3. **Raw-corpus intake has two paths; the direct one exists and the UI one is now
   planned.** Direct-to-bucket works now: an S3 client (`mc cp`, or any uploader)
   writes the raw documents under `proc/{evaluationId}/` in redline's bucket — the
   seam is plain S3, redline builds nothing for it, and the path is documented in
   `docs/guides/two-stack-local-run.md`. The **via-UI** path — upload or select in
   the browser — is the object-store write/browse port at the head of the Create
   Corpus programme; it is no longer a standalone housekeeping item. Both paths
   stage bytes only — womblex then processes the corpus and mints the
   `source_hash` identities the evaluation references, which is why
   `redline-create-evaluation.spec.ts` gates on an `E2E_REDLINE_STAGED_CORPUS_ID`
   naming a corpus **no evaluation has claimed** (`create` refuses a claimed one
   with `ALREADY_EXISTS`).

4. **The Playwright specs that need a populated evaluation wait until after UAT,
   and that is deliberate.** They prove the *served DOM* the view models bind to;
   the view models and builders are already proven framework-free in the
   `redline-web` and `redline-adapters` vitest suites — the report sheet seam's
   own exit asserts against the builder (a fixed report renders with its
   provenance intact), and the assembly loop's exit asserts byte-identity against
   the store. So nothing in the lean
   vertical is gated on these specs. Running them is post-UAT: it needs an
   `E2E_REDLINE_EVALUATION_ID`, a runner that has Playwright, and a web container
   that is not the pruned production install (no dev dependencies, no browsers).
   Scheduling that environment is not a lean-vertical concern.

5. **A lens is declared at create time, not authored.** The create screen's
   fields become the lens's topics, so the manifest is gone — but the lens is
   written once, with **no hard rules**, because a specialist typing field names
   supplies no patterns to author rules from. Nothing edits a lens after the
   fact, and there is no versioning or durable-asset lifecycle; that surface is
   housekeeping. The seed script still writes rules from a manifest, and is now
   the only path that can.

6. **A range inside a pricing *table* is still uncountable, and that is
   upstream's.** The grid's reading counts a range once at its upper endpoint
   (`readDocumentMoney`), but it can only see a range womblex grouped — and
   `money_stage.py`'s `_cell_row` attaches no `range_group`/`range_role` to cell
   spans at all, so "$1M–$2M" written in a pricing schedule arrives as two
   ungrouped rows and is counted twice. Narrative ranges are handled. Re-checked
   against womblex 0.4.0 (`d6850de`, the narrative-money release): `_cell_row`
   still neither accepts nor sets those fields, so the bump does not close this.
   Fixing it properly is a womblex change, not a redline one; raise it upstream
   rather than inferring a grouping here from adjacency.

7. **Source comments cite ADR numbers, none of which resolve.** Plan item
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

**The lean vertical ran to completion, and the Create Corpus programme now sits
between it and housekeeping.** The order is: lean vertical (done) → UAT (open) →
Create Corpus programme → housekeeping in dependency order → workspace extraction
and release.

**The product item was the report sheet seam, and it is built.** Everything
before it assembled inputs; everything after it is proof or polish. It needed
rows in the store, which can be seeded, and an assembled report as data — both
without a live run. An earlier revision sequenced a fixture run first on the
reasoning that later items would then debug against known-good connectors; in
practice that only deferred the product behind a proof of the plumbing, and the
plumbing gap it was meant to catch — the absent money-span writer — is one it
could not have caught. That ordering was withdrawn.

All its prerequisites were met and it landed: the money-span write path is built,
so spans reach the store; the tool surface over them is built and served
(`apps/redline-mcp`) including graph traversal, and registered in Wayfinder; what
a report is is settled (`architecture.md` §5.1); the assembly loop that produces
one is built (fork-side, `ReportAssembler`); and the sheet seam that renders an
assembled report to a workbook is built (`report-export.ts`, `apps/redline-web`).

**The UAT gate is the report sheet seam, and it is now open.** A corpus rendering
in a grid is a demonstration of womblex and a classifier; a specialist cannot
evaluate a tender from it, and asking them to would test the wrong thing. The
report is what makes it redline, and the seam that delivers it is built.

**The Create Corpus programme follows UAT, not housekeeping.** UAT is what
surfaced its necessity — a specialist cannot be handed a terminal to stage a
corpus and run the pipeline — so the programme is scheduled ahead of the
housekeeping set rather than inside it. Its steps have their own internal
ordering (the write/browse port before the run seam before the surface); the
synthesis document-picker rides the same port and is not separate work. Then, and
only then: housekeeping in dependency order, and finally workspace extraction and
release.

### Superseded decisions

- **Browser-driven run was descoped (2026-08-09), and that is retired
  (UAT).** The descope read: running a corpus from the browser is out of scope,
  not deferred — nothing planned it, and every evaluation begins with an operator
  at a terminal driving `seed-redline-evaluation.ts`. Its stated cost was the two
  unwritten seams (an object-store browse port, a run trigger/status seam) and the
  "redline does not wrap the engine" posture. **UAT falsified the premise**: a
  terminal is not a delivery mechanism for the specialists who use this. The
  Create Corpus programme now plans exactly those seams. The posture is
  amended rather than discarded — redline *drives and observes* the engine's run
  but still does not reimplement its batching, retry or scale-out; `architecture.md`
  §3/§5 is updated to record that as the seam is built, not ahead of it.
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
