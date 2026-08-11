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

**The run stays on the script, and that is a scope decision.** `IngestDocuments`,
`AssignDocumentsToGroups`, the cold-start classifier and `BuildEvaluationTable`
are all built and wired in `container-redline.ts`, but nothing served calls them
— `apps/web/scripts/seed-redline-evaluation.ts` drives the pipeline from a
terminal and remains the only path that does. Driving it from a browser is out of
scope (see the open questions), so an operator with a terminal stages the corpus
and starts the run; the specialist's browser surface begins at the populated
evaluation.

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
| Corpus upload via UI | domain + adapters + redline-web | The "or via UI" half of raw-corpus intake. Direct-to-bucket (`mc cp`/any S3 client into `proc/{evaluationId}/`) works today, out of product; a browser upload does not, because redline has no object-store port — its domain ports are all read surfaces (`IChunkStore`/`IGraphStore`/`IMoneySpanStore`). Needs a write-side port + S3 adapter and an upload surface that lands raw documents under the evaluation prefix the womblex engine then processes. Distinct from browser-driven *run* (still descoped): this stages bytes, it does not orchestrate extraction. |
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

2. **Running a corpus from the browser is out of scope.** Choosing which
   documents of a connected bucket are in scope for an evaluation, and starting
   the pipeline over them, was a numbered item until it was descoped on
   2026-08-09. It is not deferred-and-scheduled: nothing in this file plans it.
   What that costs, stated plainly so it is not rediscovered as a surprise —
   `IngestDocuments`, `AssignDocumentsToGroups`, the cold-start classifier and
   `BuildEvaluationTable` stay reachable only from
   `apps/web/scripts/seed-redline-evaluation.ts`, so every evaluation begins with
   an operator at a terminal. The object-storage port and adapter redline would
   need to *browse* a connected bucket in TypeScript remain unwritten (the *write*
   side — uploading a raw corpus via UI — is a tracked housekeeping item; see the
   next question). The `evaluation` router's `create` mutation is unaffected: an
   evaluation is still created in the browser over an already-staged corpus.

3. **Raw-corpus intake has two paths, and only the direct one exists today.**
   Direct-to-bucket works now, out of product: an S3 client (`mc cp`, or any
   uploader) writes the raw documents under `proc/{evaluationId}/` in redline's
   bucket — the seam is plain S3 (ADR-0002), redline builds nothing for it, and
   the path is documented in `docs/guides/two-stack-local-run.md`. The **via-UI**
   path is a real capability the intake requirement asks for and it is *not* built:
   redline has no object-store write port (its ports are all read surfaces), so a
   browser upload has nothing to call. That is now a tracked housekeeping item
   (corpus upload via UI), not an omission. Both paths stage bytes only — womblex
   then processes the corpus and mints the `source_hash` identities the evaluation
   manifest references, which is why `redline-create-evaluation.spec.ts` gates on
   an `E2E_REDLINE_STAGED_CORPUS_ID` naming a corpus **no evaluation has claimed**
   (`create` refuses a claimed one with `ALREADY_EXISTS`).

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

**The lean vertical runs to completion before the housekeeping work starts, and
it now has.**

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

Then, and only then: housekeeping in dependency order, and finally workspace
extraction and release.

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
