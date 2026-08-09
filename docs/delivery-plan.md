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
> **Nothing here has been run against live services.** The wiring and the write
> path typecheck and are unit-tested; no Postgres, sidecar or adjudicator has
> ever been behind either. Expect config-level breakage on first boot, and treat
> the corpus run (§2 item 6) as the first real proof rather than a formality.
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
delegate. Items 3 and 4 are that step, and **UAT does not start until they
work**. A demo that ends at the review grid demonstrates the dependencies.

**Numbatch is not on this path.** Classification runs cold-start over womblex
extraction: hard rules + LLM adjudication navigating the store's
chunks/provenance, with the nearest-neighbour step deferred. Pricing comes from
womblex's own currency-typed table cells / money sidecars. The Numbatch stack
re-enters only when a *trained* overlay or the financial extension's roll-up is
wanted; neither is needed to see the grid.

The read path is built and merged end to end — store-backed classifier, money
extractor, the served fork, the persisted lens, the `/evaluations` index and the
document route. **Creating** an evaluation is now a browser action too: the
`evaluation` router's `create` mutation over a picked staged corpus, gated on its
own `evaluation:create` permission. See
[`architecture.md`](./architecture.md) §3/§4/§5/§6.

**What is left of the write surface is the run.** `IngestDocuments`,
`AssignDocumentsToGroups`, the cold-start classifier and `BuildEvaluationTable`
are all built and wired in `container-redline.ts`, but nothing served calls them
— `apps/web/scripts/seed-redline-evaluation.ts` still drives the pipeline from a
terminal. Item 2 closes that, and it is genuinely thin: one mutation and one
control in front of four use cases that already compose.

**Items 2, 4 and 5 are fork-side** — the router, the routes, the report assembly
and the components all live in `services/wayfinder/apps/web`. Each is two commits
under §1's contract: the work on `redline-integration`, then the gitlink and pin
moved here in step. Item 3 is the exception among the report work: an MCP server
is addressed over a URL, so it is redline-side and deployed beside the sidecar.

**Browser *upload* is deliberately not here.** Staging a corpus needs
`ISAACUS_API_KEY`, compute and a cost decision, so it is an operator action
whoever drives it — and it is the expensive build: redline has no object-storage
code in TypeScript at all, and `IngestDocuments` confirms extraction rather than
performing it (its input is `documentIds`, and its own comment reads *"It does
not trigger womblex itself — that is the sidecar's job"*). A new port, a new
adapter and a sidecar trigger, to remove a step from a user who is not yet in the
loop. Deferred to §3.

### 1 — Prove the wiring on the in-repo fixtures

Every seam typechecks and is unit-tested; none has had a live service behind it.
This closes that for everything except the real womblex engine, and it costs
nothing: `WOMBLEX_MODE` defaults to `stub`, whose extractor is deterministic and
dependency-free, so **no `ISAACUS_API_KEY` is needed**. Compose profile `ingest`
brings up MinIO and the sidecar; `redline-postgres` takes the real migrations.
The seed script drives it, so this is not blocked on item 2.

The one seam still wanting an endpoint is the **adjudicator** — the weakest
connector in the stack, and the only one whose wire contract is asserted against
an assumption rather than a recorded response. `REDLINE_ADJUDICATOR_BASE_URL` is
just a URL, so point it at a local mock or a real model; either way this item is
where that contract stops being a guess.

What it does **not** prove: the real womblex Parquet→JSON mapping, since the stub
supplies the content. That waits for item 6.

_Version bump: PATCH_ (a run plus the runbook it produces; fixes only if it
breaks).
_Exit: with no `ISAACUS_API_KEY` set, the seed script takes the in-repo fixture
corpus to a populated grid at `/evaluations/:id/review`, served from a real
Postgres and a real sidecar, and the run is written down as a runbook._

### 2 — Run the pipeline from the browser

`IngestDocuments` (the stage confirmation) → `AssignDocumentsToGroups` →
cold-start classify → `BuildEvaluationTable` run only from the script. One
mutation and one control in front of all four, with whatever run state the screen
needs to not look frozen. Documents are already staged and extracted at this
point — that is the operator's step, and stays so.

**Settle what `AssignDocumentsToGroups` is for on this path.** `CreateEvaluation`
now writes the vendors and response groups itself and leaves the evaluation at
`documents_uploaded`, so on a browser-created evaluation that use case is
re-persisting a composition it already agrees with and advancing the stage to
`classifying`. Either call it for the stage advance and say so, or move the
advance and stop calling it — do not leave two writers of the same rows
unexplained. A script-seeded evaluation still needs it in full.

_Version bump: MINOR._
_Exit: starting a run on an evaluation whose documents have been extracted
produces a populated grid at `/evaluations/:id/review`._

### 3 — The report tool surface

The domain already assigns work to a **"report-assembler LLM"** in five places
(`chunk-store.ts`, `money-span-store.ts` ×2, `domain/index.ts`) — attaching money
spans to requirements, copying chunk text verbatim into template slots,
requirement alignment. It exists in no document, no plan item and no line of
code. This item gives it hands.

The tools already exist as port methods; what is missing is exposure. Seven of
them: `IChunkStore.fetchChunks` / `fetchByStructure`, `IMoneySpanStore
.fetchByDocument` / `fetchByStructure`, `IProcurementExtractionReader
.readElements` / `readChunks` / `readTableCells`. Wrap them as an MCP server.

**Build this rather than taking `postgres-mcp` off the shelf.** A generic SQL
tool reaches the same rows and drops the contract the ports encode: stable
ordering, so a report is reproducible; verbatim text, *"byte-identical — copied
into report slots, never paraphrased"*. Most concretely, `redline_chunks
.embedding` sits beside the text, and one `SELECT *` at ~90k chunks is a very
expensive mistake — `DrizzleStagedCorpusReader` never selects the embedding or
bulk text, and a generic tool has no such discipline. Provenance back to source
is what redline sells; it should not route through a tool that cannot guarantee
it. (`postgres-mcp` is still worth having for ad-hoc analysis, off this path.)

**Transport is constrained, and it is not a free choice.** Wayfinder's MCP client
speaks **SSE and streamable-HTTP only — no stdio** (`ai-sdk-mcp-client.ts`), and
servers are URL-addressed. Anything stdio-only cannot be reached from the fork.

**This item must settle two things it inherits.** First, whether a tender-reading
assembler asserts Wayfinder's `McpServer.communicatesExternally` — it reads
commercial-in-confidence documents. Second, the ownership contradiction:
`money-span-store.ts` says attaching a span to a requirement is the assembler's
job, while `MoneySpanFinancialExtractor` already does it by highest-confidence
classification. One of the two must stop claiming it.

_Version bump: MINOR._
_Exit: an MCP client lists the tools and calls them against a populated
evaluation, getting back verbatim chunk text and money spans with provenance —
identical results and identical ordering across two consecutive calls._

### 4 — LLM report assembly and the sheet seam

The loop is not a build: `mcp-tool-prepass.ts` already drives an AI SDK `ToolSet`
over MCP. It lives in `packages/adapters`, which redline does not vendor — but
the fork's `apps/web` reaches `@rbrasier/adapters` directly, and that is where
`container-redline.ts` already sits. **Build this fork-side and the vendoring
seam never has to widen.**

**This item must settle what a report actually is** — its sections, what an LLM
chooses versus what is transferred verbatim, and what a specialist can change
before it is exported. Nothing anywhere defines this. Settle it here and write it
into `architecture.md`; the item cannot be tested otherwise.

The export target exists and is deterministic: `buildEvaluationWorkbook` takes
grid + pivots to sheet data and the browser writes xlsx through
`write-excel-file`. What is missing is a seam where an assembled report becomes
sheets. **Prefer extending that builder over adopting an Excel MCP server**
(`haris-musa/excel-mcp-server`, MIT, streamable-HTTP, is the credible one): it
writes files server-side, which is a different delivery model to redline's
browser download, and the existing builder is deterministic and unit-testable.
Revisit only if the LLM needs to control formatting or charts.

_Version bump: MINOR._
_Exit: an LLM assembles a report over a populated evaluation, every transferred
passage byte-identical to its stored chunk, and the result exports as a workbook
a specialist can open._

### 5 — Test the React bind layer

`review-table.test.tsx` and `pricing-pivots.test.tsx` are twelve lines each,
asserting only that the export is a function and its `.name` matches — against a
207-line grid and a 157-line pivot component. The cores under `apps/redline-web/`
are covered; the core→DOM binding is not, and the Playwright specs that would
cover it skip until item 6 has run.

_Version bump: PATCH._
_Exit: both components render against fake query data in a test and assert the
rows and columns they produce, failing if the binding to the core breaks._

### 6 — Real corpus, end to end

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

**Staging is undocumented.** Every downstream step assumes the corpus is already
in the bucket, but no guide says how it gets there — `two-stack-local-run.md`
brings up MinIO and stops. The only written claim is §3's "`mc cp` stages the
bucket today", which is a note to ourselves, not a runbook. Whoever drives this
item writes that step down first; it is the one prerequisite with no instructions
at all.

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

_Version bump: PATCH_ (a run plus the runbook and any doc corrections it
produces; no shipped code).

_Exit: a specialist opens the review grid for a real tender and sees each
document delineated by topic and brand, with provenance back to source — with the
five `E2E_REDLINE_EVALUATION_ID`-gated specs
(`services/wayfinder/apps/web/e2e/redline-*.spec.ts`) green against that
evaluation as the automatable half. The run also unblocks
`redline-create-evaluation.spec.ts`, which gates on
`E2E_REDLINE_STAGED_CORPUS_ID` and needs a staged corpus **no evaluation has
claimed** — a second corpus, or one staged and left uncreated, since `create`
refuses a claimed one with `ALREADY_EXISTS`._

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
   until the corpus runs). **What a report is** was on this list by omission —
   five source comments assigned work to a "report-assembler LLM" that appeared
   in no document and no item. It is now items 3 and 4, and the definition is
   theirs to settle.

2. **A lens is declared at create time, not authored.** The create screen's
   fields become the lens's topics, so the manifest is gone — but the lens is
   written once, with **no hard rules** (none can honestly be written before
   anyone has seen how these fields land on this corpus, so every field goes to
   adjudication). Nothing edits a lens after the fact, and there is no versioning
   or durable-asset lifecycle; that surface stays in §3. The seed script still
   writes rules from a manifest, and is now the only path that can.

3. **Source comments still cite dead ADR numbers.** The documents no longer do
   (see `design-principles.md`), but comments across `packages/` and the fork do
   — e.g. `hard-rule-evaluation.ts:47` cites ADR-0011 for a precedence rule now
   stated in `architecture.md` §3. Harmless where the comment states its own
   substance, which is the common case; fix them opportunistically when touching
   the file rather than as a pass of its own.

---

## 5. Sequencing

**The lean vertical runs to completion before the deferred work starts.**

Item 1 turns "the wiring is unproven" into a fact, cheaply and without an Isaacus
key, and it is deliberately first: every later item debugs against known-good
connectors instead of discovering them. Item 2 finishes making the product
operable by someone without a terminal — creating an evaluation already is.

Items 3 and 4 are the product. Everything before them assembles inputs;
everything after them is proof or polish.

Item 5 makes the screens worth trusting. Item 6 is what all of it is for, and
runs last so it proves the product rather than the script — though the script
stays a deliberate fallback for de-risking the first live run on its own.

**The UAT gate is item 4, not item 6.** A real corpus rendering in a grid is a
demonstration of womblex and a classifier; a specialist cannot evaluate a tender
from it, and asking them to would test the wrong thing. Item 6 on its own says
the pipeline works. Items 3 + 4 are what make it redline. Do not schedule UAT
against a date that only clears item 6.

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

**Two of those bind the report work directly, and item 3 inherits both.** The
source comments describe the report-assembler as *"traversing the graph and
calling tools"* — the graph is off, so it must work without one. And with
`findSimilar` deferred it cannot search for a relevant passage either. Both tools
it gets are deterministic: exact fetch by key, structural fetch by provenance.
That is a real constraint on what a report can claim, not an implementation
detail — the assembler transfers facts it is pointed at, and the pointing is done
by classification, not by the model roaming the corpus. Design items 3 and 4 for
that, or reopen one of these two decisions deliberately.
