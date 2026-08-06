# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-08-09
>
> **This tracks outstanding work only. It does not restate design.**
> [`architecture.md`](./architecture.md) is what redline *is*;
> [`design-principles.md`](./design-principles.md) holds the durable principles
> and non-goals. Completed work and the reasoning behind superseded plans live in
> git history, not here. Item numbers are local to this file and are renumbered
> whenever the outstanding set changes.
>
> **Almost nothing here has been run against live services.** The wiring
> typechecks and is unit-tested; no sidecar and no adjudicator has ever been
> behind it. The one exception is the money-span write path, which was proven
> against a real Postgres 16 with the shipped migrations applied — the Python
> writer landing spans and `DrizzleMoneySpanStore` reading them back. Everything
> else should still expect config-level breakage on first boot; whenever a real
> corpus is first run (§4 item 3), treat that as the first real proof rather than
> a formality.
>
> **Typechecking is not evidence a path exists.** The money-span table shipped
> with a migration, a read adapter and a code comment naming a writer that was
> never built — and every consumer degraded quietly rather than failing, so
> nothing went red. It is written now, but assume there are more: when an item
> claims a seam is "built", check for the producer, not just the type. The
> `psycopg` driver both Postgres writers import was likewise declared in no
> `pyproject.toml` until that writer was built.
>
> **One open decision carried in the code.** `redline_topics.id` is a plain
> primary key, so a topic belongs to exactly one lens and a second lens reusing
> an id fails. `CreateEvaluation` works around it by scoping every topic id to
> its corpus (`{corpusId}:{field}`), which is why two tenders can both have a
> "Warranty" field — but that is a workaround, not a decision. Revisit when lens
> portability (§3) lands.

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
  **The order is forced, not stylistic:** `validate.sh` #15 fails unless the
  submodule sits on `redline-integration`'s commit, so a fork feature branch
  cannot be pinned — it must merge there first. Plan the fork PR as part of the
  step, or the second commit cannot be made.

---

## 2. The lean vertical (current priority)

**Goal: a real procurement corpus goes in, and a specialist gets a report out —
delineated by topic and brand, with provenance back to source.** The
comprehension-lens work and the trained-classifier overlay are **deferred** (§3).

**The report is the product, not the grid.** A corpus that is merely extracted,
chunked and classified is womblex plus a classifier; almost none of that needs
redline. What redline is for is the step after — assembling those addressable,
provenance-tagged facts into something a procurement specialist hands to a
delegate. The report tool surface that gives an assembler hands is built
(`apps/redline-mcp`, `architecture.md` §5 invariant 7); items 1 and 2 are what is
left of that step, and **UAT does not start until they work**. A demo that ends at
the review grid demonstrates the dependencies.

**Numbatch is not on this path.** Classification runs cold-start over womblex
extraction: hard rules + LLM adjudication navigating the store's
chunks/provenance, with the nearest-neighbour step deferred. Financial facts come
from womblex's own value-typed table cells / money sidecars. The Numbatch stack
re-enters only when a *trained* overlay or the financial extension's roll-up is
wanted; neither is needed to see the grid.

**"Pricing" is the wrong word for this layer, and using it has already cost us.**
What womblex lands is *financial expressions* — value-typed spans with a currency,
a magnitude and provenance. A price is one reading of one of those. The store and
the ports underneath must carry the general thing; interpretation (which
requirement it belongs to, what it rolls up to, whether it is a price at all) is a
consumer's job and belongs above them. The alternative — a bespoke path per
financial-data type — is a build with no end. The money-span store is built
against that rule (`architecture.md` §4 step 2'), and
`MoneySpanFinancialExtractor`'s contract (one AUD figure per (document,
requirement)) is one reading above it — a narrowing to hold at arm's length rather
than entrench.

The read path is built and merged end to end — store-backed classifier, money
extractor, the served fork, the persisted lens, the `/evaluations` index and the
document route. **Creating** an evaluation is now a browser action too: the
`evaluation` router's `create` mutation over a picked staged corpus, gated on its
own `evaluation:create` permission. See
[`architecture.md`](./architecture.md) §3/§4/§5/§6.

**The run stays on the script, and that is now a scope decision.** `IngestDocuments`,
`AssignDocumentsToGroups`, the cold-start classifier and `BuildEvaluationTable`
are all built and wired in `container-redline.ts`, but nothing served calls them
— `apps/web/scripts/seed-redline-evaluation.ts` drives the pipeline from a
terminal and remains the only path that does. Driving it from a browser is **out
of scope** (§4 item 2), so an operator with a terminal stages the corpus and
starts the run; the specialist's browser surface begins at the populated
evaluation.

**Item 1 is fork-side** — the report assembly lives in
`services/wayfinder/apps/web`, so it is two commits under §1's contract: the work
on `redline-integration`, then the gitlink and pin moved here in step. Item 2 is
redline-side: the workbook builder already lives in `apps/redline-web`. So is the
report tool surface item 1 calls, which is built and served over a URL the fork
registers rather than imports.

**The report work is not gated on a pipeline run, and treating it as though it
were is a planning error we have already made once.** Items 1 and 2 need *rows
in the store* — chunks, spans, responses with provenance — not a live
extract→classify→build sequence that produced them. Those rows can be seeded
straight into Postgres, which is how `packages/redline-adapters`' own suite
already works (PGlite, seeded rows, no services). Build them against a seeded
store and let the corpus run confirm them later; do not let the two block each
other again.

**The in-repo fixture corpus is what this plan builds against, and that is a
settled scope decision.** Seeded rows plus the fixture corpus are sufficient to
build and prove every item below; a real-corpus run is the owner's to call and is
not scheduled here (§4 item 3). One limit to hold while reading any fixture
result: the `WOMBLEX_MODE=stub` extractor never reads the corpus — it synthesises
each document from the name it is given — so a fixture run exercises connectors
and shapes, never document content. Claims about what redline *understands*
belong in unit tests over seeded rows, which is where they already are. The
manifest is written
(`services/womblex-ingest/tests/corpus/redline-manifest.json`, with the ordering
constraint and the stub's limits recorded beside it).

### 1 — LLM report assembly

The loop is not a build: `mcp-tool-prepass.ts` already drives an AI SDK `ToolSet`
over MCP. It lives in `packages/adapters`, which redline does not vendor — but
the fork's `apps/web` depends on `@rbrasier/adapters` directly (its
`package.json`, verified), and that is where `container-redline.ts` already sits.
**Build this fork-side and the vendoring seam never has to widen.**

**The seven tools it drives already exist**, served over streamable HTTP from
`apps/redline-mcp`. Register that server in Wayfinder as `streamable-http` at
`http://redline-mcp:8930/mcp` with `communicatesExternally: false`
(`architecture.md` §5 invariant 7 records why, and why `true` would make this item
unbuildable). What is unbuilt is the loop above them.

**This item must settle what a report actually is** — its sections, what the
model chooses versus what is transferred verbatim, and what a specialist can
change before it is exported. Nothing anywhere defines this. Settle it here and
write it into `architecture.md`; the item cannot be tested otherwise, and item 2
cannot start without it.

The verbatim rule is the testable part and the reason to do this before the
export: a transferred passage must be byte-identical to its stored chunk, because
that is the provenance claim the product makes. Assert it directly.

_Version bump: MINOR._
_Exit: an LLM assembles a report over a populated evaluation, and every
transferred passage is byte-identical to the chunk it came from — asserted
against the store, not eyeballed._

### 2 — The report sheet seam

The export target exists and is deterministic: `buildEvaluationWorkbook` takes
grid + pivots to sheet data and the browser writes xlsx through
`write-excel-file`. What is missing is a seam where an assembled report becomes
sheets. Split from item 1 because it is independently testable — a fixed report
structure exports correctly whether a model or a fixture produced it — and
because it is the half a specialist actually receives.

**Prefer extending that builder over adopting an Excel MCP server**
(`haris-musa/excel-mcp-server`, MIT, streamable-HTTP, is the credible one): it
writes files server-side, which is a different delivery model to redline's
browser download, and the existing builder is deterministic and unit-testable.
Revisit only if the LLM needs to control formatting or charts.

_Version bump: MINOR._
_Exit: a fixed report structure renders to a workbook a specialist can open, with
its provenance intact, proven by a test over the builder rather than by opening
the file._

---

## 4. Housekeeping — off the vertical, wanted before users

Deferred until the lean vertical is complete. Revisit the lens work **after** the
corpus run has shown what the cold-start path actually gets right — that evidence
should shape it rather than be assumed. In dependency order:

| Item | Package(s) | Notes |
|---|---|---|
| Collision selection, ordering & capping | domain | Bounded, deterministic selection of genuinely ambiguous documents. |
| `BoundaryDecision` entity | domain | Net-new modelling. Owns "primary/secondary semantics" (see §6). |
| Decision persistence + corrections push | adapters | Shrunk: upstream owns corrections + audit — an adapter call over an existing API, not a build. |
| Lens persistence | adapters | Shrunk: the classification-side tables are built. What remains: the lens's Numbatch bindings (references, not copies), the authoring surface, and the durable-asset surface. |
| Lens portability | application | Apply a saved lens to a different corpus; its boundary decisions still bite. |
| Lens stage machine | redline-web | Define → map → resolve → save, its own machine. |
| Collision resolution surface | redline-web | View model + controller for resolving a collision set. |
| Sample accrual | adapters | Shrunk: upstream topic-scoped dedupe indexes give re-push idempotence for free. |
| Train/activate policy | adapters | Needs redesign — auto-activation contradicts upstream ADR-0021 (activation is a user-controlled pointer move with a replay diff). Surface the upstream flow: auto-*train* on crossing the floor, then let the specialist activate. |
| Workspace extraction & release prep | workspace | Standalone workspace; sever the vendoring seam; graft the financial overlay onto the fork. Last by nature. |

---

## 6. Open questions

1. **Open questions still owned here:** tenancy mapping — Numbatch
   `organisation_id` ↔ Wayfinder identity (settle before a lens is shared between
   users); primary/secondary semantics (Numbatch returns score-sorted ≤3 topics
   with no primary/secondary distinction; owned by `BoundaryDecision` in §3);
   ambiguity thresholds (the signal register needs initial values, unmeasured
   until the corpus runs). **What a report is** was on this list by omission —
   five source comments assigned work to a "report-assembler LLM" that appeared
   in no document and no item. That assembler now has hands (`apps/redline-mcp`),
   and the definition is item 1's to settle.

2. **Running a corpus from the browser is out of scope.** Choosing which
   documents of a connected bucket are in scope for an evaluation, and starting
   the pipeline over them, was §2 item 1 until it was descoped on 2026-08-09. It
   is not deferred-and-scheduled: nothing in this file plans it, and the deferred
   set in §3 does not carry it either. What that costs is stated plainly so it is
   not rediscovered as a surprise — `IngestDocuments`,
   `AssignDocumentsToGroups`, the cold-start classifier and
   `BuildEvaluationTable` stay reachable only from
   `apps/web/scripts/seed-redline-evaluation.ts`, so every evaluation begins with
   an operator at a terminal, and the object-storage port and adapter redline
   would need to upload or browse a bucket in TypeScript remain unwritten. The
   `evaluation` router's `create` mutation is unaffected: an evaluation is still
   created in the browser over an already-staged corpus. Two live consequences:
   how a corpus reaches the bucket is written down nowhere and no item now owns
   writing it (item 3 records the gap, but a run is not scheduled); and
   `redline-create-evaluation.spec.ts` still needs an
   `E2E_REDLINE_STAGED_CORPUS_ID` staged by hand.

3. **A real-corpus run is called by the owner, not scheduled here.** The fixture
   corpus is what the lean vertical is built and proven against (§2 preamble). A
   run over a real tender happens when whoever holds `ISAACUS_API_KEY`, the
   compute and the tender says it happens; this file does not sequence it and
   nothing above is gated on it. It was a numbered §2 item until that decision on
   2026-08-09. What such a run would do, recorded so it need not be rediscovered:
   `womblex` profile ingests → the sidecar extracts, chunks and embeds → chunk
   rows and embeddings materialise into the `redline_` store → group by vendor →
   cold-start classify → render, over a corpus in the git-ignored
   `services/womblex-ingest/tests/corpus-local/` (a README today). Extraction
   provenance serves as JSON; bulk vectors load as data but are not ANN-indexed.
   The enrich graph is off in redline's profile (`enrichment.enabled: false`);
   turning it on is a config plus Isaacus-cost decision that would extend the
   store-load path to carry graph edges. A run is also the only thing that would
   settle **the three OCR-table gates** (paddleocr-only, deskew refusal,
   precision refusal), and the only source of the `E2E_REDLINE_EVALUATION_ID` the
   five seed-gated Playwright specs wait on — plus the
   `E2E_REDLINE_STAGED_CORPUS_ID` that `redline-create-evaluation.spec.ts` needs,
   which must name a corpus **no evaluation has claimed**, since `create` refuses
   a claimed one with `ALREADY_EXISTS`. **Staging is written down nowhere** —
   `two-stack-local-run.md` brings up MinIO and stops, and §3's "`mc cp` stages
   the bucket today" is a note to ourselves, not a runbook; whoever drives a run
   writes that step first.

   > **Upstream-behaviour facts to bake into the runbook (not obvious from config).**
   > Line references verified against the pinned `services/womblex` @ `v0.3.0` on
   > 2026-08-09.
   > (a) `womblex run` writes `elements`/`table_cells`/`form_fields` but **does not
   > persist chunks** — `write_batch_parquet` passes only `(doc_id, path, extraction)`
   > to `write_results` (`src/womblex/operations/persist.py:18-27`), and chunks hang
   > off `result.chunks`. Chunking and embedding are separate per-stage commands
   > (`womblex chunk --shards` then `womblex embed --shards`) over the run's shard dir.
   > (b) But `run` still *computes* chunking when `chunking.enabled`
   > (`src/womblex/batch.py:63-64` — the top-level module, **not**
   > `operations/batch.py`, which does not exist) and then discards it, so a keyed
   > run does the work twice. Wasted CPU and wall
   > clock, **not** Isaacus spend — redline sets no `chunking_model`, so chunking is
   > local semchunk over the Kanon-2 tokeniser the engine vendors in-tree at
   > `src/womblex/_models/kanon-2-tokenizer/`. Setting `chunking.enabled: false` for
   > the `run` pass avoids it and is safe for the prescribed `chunk --shards` path,
   > which ignores that flag — but `womblex chunk --config` **refuses outright** when
   > it is false (`src/womblex/cli/pipeline.py:418-420`), so do not flip it if anyone
   > uses the `--config` composition. (c) The **chunk** stage is Isaacus-gated in
   > 0.3.0 and the gate is a **pre-flight policy refusal**, not a capability limit —
   > `cli/pipeline.py:152` computes `chunk_will_skip = config.chunking.enabled and
   > not isaacus_available()` before any tokeniser loads. Settled by reading the
   > engine, see `architecture.md` §7.1; plan around it rather than re-testing it.
   > (d) The **embed** stage is unambiguously Isaacus-gated
   > (`kanon-2-embedder`), and **`enrich`/`linking` are disabled** in redline's
   > profile (`infra/womblex/redline.yaml:72-75`, so no graph is produced unless
   > turned on).

4. **A lens is declared at create time, not authored.** The create screen's
   fields become the lens's topics, so the manifest is gone — but the lens is
   written once, with **no hard rules** (none can honestly be written before
   anyone has seen how these fields land on this corpus, so every field goes to
   adjudication). Nothing edits a lens after the fact, and there is no versioning
   or durable-asset lifecycle; that surface stays in §3. The seed script still
   writes rules from a manifest, and is now the only path that can.

5. **A range inside a pricing *table* is still uncountable, and that is
   upstream's.** The grid's reading now counts a range once at its upper endpoint
   (`readDocumentMoney`), but it can only see a range womblex grouped — and
   `money_stage.py`'s `_cell_row` attaches no `range_group`/`range_role` to cell
   spans at all, so "$1M–$2M" written in a pricing schedule arrives as two
   ungrouped rows and is counted twice. Narrative ranges are handled. Fixing this
   properly is a womblex change, not a redline one; raise it upstream rather than
   inferring a grouping here from adjacency.

6. **Source comments cite plan item numbers, which are guaranteed to rot.** Files
   across `packages/`, `apps/` and `services/womblex-ingest` carry
   `(delivery-plan §2 item 1)` / `(item 1a)` / `(item 1b)` referring to several
   different past items — this file renumbers whenever the outstanding set
   changes, so any such citation is dead the next time it does. Do not add more:
   cite `architecture.md`, which is stable, or state the substance in the comment.
   Fix the existing ones when touching the file. (Deliberately not counted here: a
   count is one more thing that rots. `grep -rn 'delivery-plan.*item\|(item 1'`
   is the live answer.)

7. **Source comments still cite dead ADR numbers.** The documents no longer do
   (see `design-principles.md`), but comments across `packages/` and the fork do
   — e.g. `hard-rule-evaluation.ts:47` cites ADR-0011 for a precedence rule now
   stated in `architecture.md` §3. Harmless where the comment states its own
   substance, which is the common case; fix them opportunistically when touching
   the file rather than as a pass of its own.

---

## 7. Sequencing

**The lean vertical runs to completion before the deferred work starts.**

**Items 1 and 2 are the product, and nothing here may gate them on a run.**
Everything before them assembles inputs; everything after them is proof or polish.
They need rows in the store, which can be seeded (§2 preamble) — so they start
now. An earlier revision of this plan
sequenced a fixture run first on the reasoning that later items would then debug
against known-good connectors; in practice that reasoning only deferred the
product behind a proof of the plumbing, and the plumbing gap it was meant to catch
— the absent money-span writer — is one it could not have caught. That ordering is
withdrawn.

The report work's prerequisites are met: the money-span write path is built, so
the spans reach the store, and the tool surface over them is built and served
(`apps/redline-mcp`), so item 1 registers a URL rather than building one. Nothing
in the lean vertical now waits on another item to start.

Item 3 makes the screens worth trusting and can land any time. A real-corpus run
is what all of it is for, and is the owner's call (§4 item 3) — it confirms the
product rather than being scheduled against it.

**The UAT gate is item 2.** A real corpus rendering in a grid is a demonstration
of womblex and a classifier; a specialist cannot evaluate a tender from it, and
asking them to would test the wrong thing. A corpus run on its own says the
pipeline works. Items 1–2 are what make it redline. Do not schedule UAT against a
date that only clears a run.

Then, and only then: §3 in dependency order, and finally workspace extraction and
release.

### What the lean vertical deliberately does not do

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

**Two of those bind the report work directly, and the built tool surface is shaped
by both.** The source comments describe the report-assembler as *"traversing the
graph and calling tools"* — the graph is off, so it must work without one. And with
`findSimilar` deferred it cannot search for a relevant passage either. So
`apps/redline-mcp` exposes neither: every tool on it is deterministic — exact fetch
by key, structural fetch by provenance. That is a real constraint on what a report
can claim, not an implementation detail — the assembler transfers facts it is
pointed at, and the pointing is done by classification, not by the model roaming
the corpus. Design items 1 and 2 for that, or reopen one of these two decisions
deliberately and widen the tool surface with it.
