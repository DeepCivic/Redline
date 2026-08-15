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

## 0. Evaluation-surface removal — outstanding remediation (READ FIRST)

**The Evaluation feature was deleted on 2026-08-15 as a product pivot.** Only
*whole* Evaluation-specific files were removed; every change that needed a
surgical edit was deliberately left, and is listed here.

> **Neither repo builds in this state.** Barrels, containers and manifests still
> reference deleted modules. Do not attempt a release, a `./validate.sh` run or a
> gitlink bump until §0.2 is done. This is a known, recorded mid-pivot state, not
> a regression to bisect.

**What redline is after this pivot:** a corpus-ingest-and-report substrate. A
specialist uploads documents into a named run (Create Corpus), womblex
extracts/chunks/embeds/enriches/prices it, and the resulting chunks, graph,
money-spans and extraction JSON serve two independent consumers — the fork's
Create Corpus UI and `apps/redline-mcp`'s report tools. There is no Evaluation
aggregate, no classification/adjudication/lens stack, no review grid, no pricing
pivots and no Numbatch dependency.

**Decisions already taken (do not relitigate):** `apps/redline-mcp` survives
untouched (it never depended on the Evaluation entity); Create Corpus survives
and must be decoupled from the Evaluation router/permission/container it
currently shares; the Numbatch integration goes entirely.

### 0.1 What was deleted

96 files in this repo, 35 in the fork: the whole `redline-domain` entities
directory and its seven Evaluation ports; the entire `packages/redline-application`
package (every use case in it was Evaluation-specific); the Evaluation
persistence, lens, adjudication and Numbatch adapters; the eight Evaluation view
models and brains in `apps/redline-web/src/lib`; and in the fork, the whole
`/evaluations` route tree, its two components, seven e2e specs, and the seed /
manifest / report-verifier / language-model libs.

### 0.2 Outstanding remediation, in dependency order

| # | Where | What is left |
|---|---|---|
| 1 | `packages/redline-domain/src/index.ts` | 18 dangling `export *` lines for deleted entities and ports. |
| 2 | `packages/redline-domain/src/ports/ports.test.ts` | Mixed file — imports deleted Evaluation entities but also covers surviving ports. Trim to the survivors rather than deleting. |
| 3 | `packages/redline-adapters/src/index.ts` | Dangling exports at the Numbatch, evaluation-repository, lens-reader/writer, candidate-deriver and adjudicator blocks. |
| 4 | `packages/redline-adapters/src/persistence/schema.ts` | Drop the 8 Evaluation tables (`redline_evaluations`, `_vendors`, `_response_groups`, `_responses`, `_lenses`, `_topics`, `_hard_rules`, `_lens_bindings`). Keep `redline_chunks`, `_money_spans`, `_graph_entities`, `_graph_edges`. A stale `row-mapping.ts` comment at line 10 also needs removing. |
| 5 | `packages/redline-adapters/src/persistence/` | Add `0007_redline_drop_evaluation_tables.sql` dropping those 8 tables in FK-safe order and append it to `MIGRATION_FILES`. **Forward-only:** every migration here is `IF NOT EXISTS`-guarded and re-applied on every boot, so old migrations must not be edited or deleted. |
| 6 | `apps/redline-web/src/lib/container.ts` | Replace `WorkflowContainer`/`WorkflowController` with a 3-field corpus container (`stagedCorpusReader`, `stagedCorpusWriter`, `runTrigger`) and a controller keeping only `listStagedCorpora`, `listStagedDocuments`, `corpus()`, `runStatus()`. Drop `productName`, `buildColdStartClassifier`, `buildMoneySpanFinancialExtractor`. |
| 7 | `apps/redline-web/src/lib/report-export.ts` (+ test) | Decouple from the deleted `excel-export.ts` — it needs only `SheetCell`/`SheetData`/workbook shapes, which can be local. Its data source (`AssembledReport`) was never Evaluation-specific. |
| 8 | `apps/redline-web/src/index.ts`, `container-test-fixtures.ts`, `container-wiring.test.ts`, `container.test.ts` | Prune to the surviving corpus/run-status/report-export surface. |
| 9 | Manifests | Remove `@redline/redline-application` from `packages/redline-adapters/package.json:24`, `apps/redline-web/package.json:23`, `services/wayfinder/apps/web/package.json:28`, and `tsconfig.json:7`. |
| 10 | `validate.sh` | Delete check 5 (redline-application purity — the directory is gone); check 11 and the `RUFF_TARGETS` entry in check 13 go with the Numbatch removal below. |
| 11 | Numbatch removal | `git submodule deinit services/numbatch` + `.gitmodules` entry. Note `services/numbatch-extension` is **not** a submodule — it is a tracked directory, removed with a plain `git rm -r`. |
| 12 | Fork: `apps/web/src/server/routers/evaluation.ts` (+ test) | Split: delete the eight Evaluation procedures, keep `createCorpus`/`runStatus`/`resumeRun` plus `stagedCorpora`/`stagedDocuments`, and move them to a `corpus.*` namespace. |
| 13 | Fork: `apps/web/src/lib/container-redline.ts` (+ test) | Trim to the three surviving ports once item 6 lands. |
| 14 | Fork: permissions | Delete `evaluation:review`; rename `evaluation:create` → `corpus:create` in `packages/domain/src/entities/permission.ts` and `packages/adapters/src/auth/seed-roles.ts`. Verified 1:1 — the surviving surface is exactly what `evaluation:create` already gated. |
| 15 | Fork: `apps/web/src/components/sidebar.tsx` | Remove the Evaluations nav entry; re-gate Create Corpus on the renamed key. |
| 16 | Fork: `create-corpus/_content.tsx` + `e2e/redline-create-corpus.spec.ts` | Remove the "Compose the evaluation" CTA linking to the deleted `/evaluations/new`. |
| 17 | Fork: `apps/web/src/lib/redline-link.test.ts` | Package-resolution smoke test; drop its `@redline/redline-application` assertion. |
| 18 | Docs | Rewrite `architecture.md` to the substrate framing above; strip the Evaluation half of this file (§2, §2.1, §3's lens/classification items, §4); revisit `design-principles.md` — **D1, D2, D6, D8 and D9 are about the comprehension lens or boundary decisions and no longer hold**; D7 needs rewording (its "resolutions are additive overlays" half went with them, its womblex-sidecar half stands); D4, D5 and D10 survive unchanged. The first five non-goals are lens re-entry conditions. `.claude/CLAUDE.md` needs its Project Identity and Architecture Rules updated (the `redline-application` bullet and the Apps-import bullet). |

### 0.3 QA findings from the deleted mount

A review of the post-run population mount found seven issues. **Five died with
the code** (the `/review` redirect breaking create-only users; `populated: false`
having no retry path; `stage: "review"` being asserted rather than read; the
create mutation blocking on the whole reading pass; the create spec's weak
`element=` assertion, which an unclassified row satisfied). Two are worth
carrying forward as *lessons* rather than fixes: a long-running mutation with no
recovery path needs a served retry before it ships, and an exit test must assert
the thing it claims — `element=` matched `?element=0`, which is what an
unread document produces.

---

## 1. The build-step contract

- One build step including its test. If the exit test needs two unrelated things
  built first, it is two steps.
- One agent, one context. One commit. A PR only on explicit request.
- Tests-first: the test file is written before the implementation file.
- One package where possible.
- **A fork-side step is two commits, not one** — one in `services/wayfinder`,
  one here moving the gitlink onto it. That is how gitlinks work, not a policy.
  What *is* a policy: `validate.sh` #14 fails unless the submodule sits on the
  fork `main`'s commit, so a fork feature branch cannot be pinned — it must merge
  there first. Plan the fork PR as part of the step, or the second commit cannot
  be made.

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

**We track womblex latest.** The engine is consumed for capabilities redline does
not reimplement, so the submodule follows womblex's `main` rather than sitting on
an older commit — currently `d6850de`, declared version `0.4.0`, which is
`origin/main`. Lagging it means going without a capability or growing a
redline-side substitute, which is the duplication the submodule discipline exists
to prevent. The gitlink is the only pin — nothing restates the version, so a bump
is one edit plus any claim in the docs that names a specific commit. The
discipline itself is in `architecture.md`; what belongs here is that a bump is
ordinary work, not a decision to relitigate.

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

**The browser now starts a run and follows it all the way to a populated
evaluation.** The Create Corpus tab uploads raw documents, fires the womblex run
against the config it authored, and the tracker follows the run to `done` — which
projects the run's own shards into `redline_chunks`, so the corpus a browser made
is visible to `/evaluations/new`. redline's *own* post-run sequence —
`IngestDocuments`, grouping, the cold-start classifier and `BuildEvaluationTable`
— is chained behind one served brain, `WorkflowController.populate` (redline-web),
and the fork mount now calls it: `evaluation:create` drives `populate` itself
right after composing the evaluation, so a specialist who composes one over a
freshly-run corpus lands on a review grid with responses already built, not one
with documents and none. A population failure carries its own state on the
response rather than presenting as a rejected create — the evaluation already
exists and is reachable even when the reading passes over it fail.

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

## 2.1 The Create Corpus programme (done)

**Goal: a specialist starts a corpus from the browser — uploads raw documents,
authors the run config, triggers the womblex run, watches it drain, and then
composes an evaluation over the result — with no terminal in the loop.** The loop
now closes end to end; the notes below are what shipped and what stays
deliberately deferred.

**What is built.** The full ingest half. `IStagedCorpusWriter` /
`MinioStagedCorpusWriter` stage a specialist's bytes under
`proc/{evaluationId}/inputs/`. The run trigger + status seam (`IWomblexRunTrigger`
/ `HttpWomblexRunTrigger` and the sidecar's `run_trigger.py`) fires the fixed CLI
sequence against the UI-authored config, layers the current stage over
`womblex_jobs` for status, and on completion projects the run's shards into
`redline_chunks` (the load `POST /ingest` drives) so the corpus a run makes is
visible to `/evaluations/new`. The authored override reaches the engine:
`TriggerRunRequest` / `RunPlan` carry the allow-listed `configOverride` and the
runner layers it over `redline.yaml` per stage — chunk mode, money vocabulary and
the first-run extraction/OCR settings (`extraction.ocr.engine` / `.dpi`, layered
at the extraction worker because that is the only pass that reads them), and now
`chunkMode.chunkingModel` — carried and applied rather than refused, ordered so
`enrich` runs before `chunk` whenever a model is resolved (semantically bounded
chunks, landed), and now nameable from the screen rather than only inherited.
The Create Corpus tab is the cold-start ingest surface: it names the run, uploads
raw documents, authors
the config, fires, tracks the four states and links to `/evaluations/new` on
`done` — no brands, no fields, no `source_hash` needed before the run reads. It is
gated on `evaluation:create` and pinned (the submodule gitlink).
`architecture.md` §3/§5 records the second engine seam; `design-principles.md`
carries the wider-first-run override decision; `docs/guides/create-a-corpus.md`
describes the surface. `redline_chunks` now also carries the element range each
chunk was cut from — `startChar`/`endChar` for a narrative chunk, `elementOrder`
for a table chunk — so `resolveChunkForMoneySpan` (redline-adapters) resolves a
money span to the one chunk containing it instead of to its whole document
(chunk element addressing, landed; a sheet_cell span still resolves to no chunk,
since a spreadsheet-sheet chunk carries no anchor element to match against).

**Post-run population is mounted.** `WorkflowController.populate` (redline-web)
takes a settled evaluation — created over a finished corpus, its groups and lens
persisted but no responses — through the reading passes the seed script drives
(`IngestDocuments` → `advance` over the persisted groups → `buildTable`), and is
re-runnable: a resumed run that finds a response set already built returns it
untouched rather than double-writing it. The fork mount — two commits, the
procedure and the gitlink bump — calls `populate` right after
`evaluation:create` composes the evaluation, so a specialist who creates one over
a freshly-run corpus lands on the review grid with responses already built. A
population failure is carried as its own state on the response (`populated: false`,
`populationError`) rather than presenting as a rejected create, since the
evaluation already exists and is reachable even when the reading passes over it
fail.

redline *drives and observes* the engine's run but does not reimplement its
batching, retry or scale-out — those stay the engine's (`cloud/worker.py`, its
Postgres queue). The sidecar owns trigger and status because it already runs the
engine from the submodule source, which keeps the queue schema out of redline;
status is polled, not streamed, because a run is minutes-long and changes state
coarsely; resume is re-firing the same run (idempotent enqueue + skip-on-output),
not resume logic of redline's own. Create Corpus is a standalone tab, not a change
to `/evaluations/new` — ingest and evaluation are different users.

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

**Deferred: raw-bucket browse.** The one open document-selection question is
whether a picker should *browse raw bucket objects* a run has not processed. That
waits, because Create Corpus uploads the documents it is about to run rather than
selecting from what is already there. The staged-corpus picker
`IStagedCorpusReader` serves stays where it belongs, on `/evaluations/new`,
listing corpora a run has already extracted.

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

2. **Raw-corpus intake has two paths; both the direct and the UI-write path
   exist.** Direct-to-bucket works: an S3 client (`mc cp`, or any
   uploader) writes the raw documents under `proc/{evaluationId}/` in redline's
   bucket — the seam is plain S3, redline builds nothing for it, and the path is
   documented in `docs/guides/two-stack-local-run.md`. The **via-UI write** path is
   built (`IStagedCorpusWriter`, driven by the Create Corpus tab); the
   **browse/select** half (listing raw objects to pick from) is deferred with the
   document-selection work. Both paths stage
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

**The order is: lean vertical (done) → Create Corpus programme (done) →
housekeeping in dependency order → workspace extraction and release.**

The ingest surface, the run trigger/status seam, the shard load on completion,
the first-run OCR config, semantically bounded chunks (on by default, and now
nameable per-run from Create Corpus), chunk element addressing and the post-run
population brain (`WorkflowController.populate`), now mounted on
`evaluation:create`, are all built. Nothing is outstanding on the Create Corpus
programme; housekeeping (§3) is next, in dependency order. Raw-bucket *browse*
and the synthesis picker stay deferred.

### Superseded decisions

- **AI chunking "refused, deliberately" is retired (2026-08-14) — and this is the
  second time.** The refusal was never agreed; it was reversed once and came
  back. It was recorded in this plan and in `docs/guides/create-a-corpus.md` as
  built behaviour, on the grounds that AI chunking requires enrich before chunk
  and the authorable stage sequence cannot express that ordering. Reading the
  pinned engine settles it: `cloud/stage_contracts.py` marks the enrichment-doc
  input `strict=False` with the comment *"Ordering requirement, not a hard
  dependency: without the sidecar the chunker self-enriches (double cost, same
  output). Warn, don't fail."* The constraint the refusal was built on does not
  exist; the cost of the wrong order is a duplicate Isaacus charge, avoidable by
  ordering enrich first. **"A duplicate charge, not a wrong result" was too
  strong, and the build caught it.** Ordering enrich first is correct for the
  chunker but writes the graph before any chunk exists, so every mention lands
  `chunk_index = -1` with no mention→chunk edges — the navigation mechanic
  `IGraphStore` walks. womblex ships the repair (`analyse/graph_refresh.py`,
  offline, API-free, idempotent), and the sidecar now inserts `graph-refresh`
  after chunk whenever enrich and chunk both run. So the ordering is right *and*
  it carries a third stage; the refusal was still wrong, but this is what it
  cost to get the alternative correct. Recorded here rather than quietly fixed because it has now
  regressed once: a decision that keeps returning needs a written reason it is
  wrong, not just a reverting commit. The requirement it violated is that chunks
  read by embed, enrich and the evaluation tool be semantically bounded — a
  480-token budget split puts deterministic money figures in incoherent context,
  which defeats the reason the money pass exists.

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
  change to `@rbrasier/domain`'s shape brings the contract test along with the
  gitlink bump.

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
