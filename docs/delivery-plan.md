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
  lands on `redline-integration` there, then needs the gitlink *and*
  `wayfinder.pin`'s `ref` moved here in step. Letting those two drift is what
  left redline typechecking against a domain package the fork had moved past.
  **The order is forced, not stylistic:** `validate.sh` #15 fails unless the
  submodule sits on `redline-integration`'s commit, so a fork feature branch
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
delegate. The report tool surface that gives an assembler hands is built
(`apps/redline-mcp`) — the deterministic chunk/money/extraction fetches **and now
graph traversal** — and **what a report is** is settled in `architecture.md` §5.1.
The items below are what is left of that step, and **UAT does not start until they
work**. A demo that ends at the review grid demonstrates the dependencies.

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
were is a planning error we have already made once.** Both items need *rows in
the store* — chunks, spans, responses with provenance — not a live
extract→classify→build sequence that produced them. Those rows can be seeded
straight into Postgres, which is how `packages/redline-adapters`' own suite
already works (PGlite, seeded rows, no services).

**Item 2 is fork-side** — the report assembly lives in
`services/wayfinder/apps/web`, so it is two commits under the build-step
contract. Item 3 is redline-side: the workbook builder already lives in
`apps/redline-web`. So is the report tool surface item 2 calls, which is built and
served over a URL the fork registers rather than imports.

### 1 — QA the report-tool-surface changes (redline-side)

The graph-traversal half of the tool surface and the report definition landed as a
redline-side change; this item is the QA pass over it before the fork-side loop
builds on top. Nothing here is net-new design — it is verification that what was
just merged holds under the gate and reads correctly.

**What landed, to QA:**

- **`IGraphStore` port** (`redline-domain`) — `fetchEntities` / `fetchEdgesFrom` /
  `fetchEdgesTo`, mirroring womblex's `enrich` sidecars (`ENTITY_SCHEMA` /
  `GRAPH_EDGE_SCHEMA`) uninterpreted. No graph loaded is an empty read, never an
  error.
- **`DrizzleGraphStore` + `redline_graph_entities` / `redline_graph_edges`**
  (`redline-adapters`, migration `0005_redline_graph.sql`) — the store-side query
  surface, read-only, mirroring the DDL the sidecar's enrich load path will write
  (that Python loader is **not** built here — same posture as the chunk loader).
- **Three graph tools on `apps/redline-mcp`** — `graph_find_entities`,
  `graph_edges_from`, `graph_edges_to`, so the surface serves ten tools. Each
  reports `graphAvailable`, distinguishing an empty match over a *loaded* graph
  from an *absent* one, so an assembler can report unreachability rather than a
  silently thin answer.
- **`architecture.md` §5.1 — what a report is:** ordered sections
  `{ heading, body, citations }`; the model chooses ordering/heading/connective
  prose, never authors facts; every load-bearing claim is a verbatim transferred
  passage or a money span, each with a citation; the byte-identity rule is the
  provenance claim; a specialist may reorder/edit-prose/remove but never silently
  reword a transferred passage before export.

**QA checklist:**

- `./validate.sh` green (size guard, purity — no vector or Parquet type crosses
  `redline-domain`, prefix guard on the two new tables).
- The end-to-end MCP test proves entity → edge → chunk → **byte-identical**
  verbatim text over a real client, and the graph-absent evaluation reports
  `graphAvailable: false`.
- Migration idempotency holds (apply twice, no error).
- The domain purity check still passes with `IGraphStore` exported.
- Read `architecture.md` §5.1 against invariant 7 for consistency (both now say
  ten tools, graph built, findSimilar the one deferred).

_Version bump: none (verification of a merged MINOR)._
_Exit: `./validate.sh` green; the graph-traversal MCP path proven end to end
including the byte-identity assertion and the `graphAvailable: false` case; §5.1
and invariant 7 read consistently._

### 2 — LLM report assembly (fork-side) + register the MCP server

The redline-side surface is done (item 1). What is left is fork-side and is two
commits under the build-step contract:

**a) Register the report tool server in Wayfinder.** `apps/redline-mcp` is served
over streamable HTTP; register it as `streamable-http` at
`http://redline-mcp:8930/mcp` with `communicatesExternally: false` (invariant 7 —
`true` would make it unselectable in flows and the assembler unbuildable). This is
a `RegisterMcpServer` call, so it needs a list-then-create guard to stay
idempotent (the use-case always creates). Mirror the existing seed patterns
(`redline-seed-evaluation.ts` / its script) rather than an admin click, so a UAT
bring-up is scripted.

**b) Build the assembly loop.** Not a build from scratch: `mcp-tool-prepass.ts`
already drives an AI SDK `ToolSet` over MCP, lives in `@rbrasier/adapters` (which
the fork's `apps/web` depends on directly), and `container-redline.ts` already
sits beside it. **Build this fork-side and the vendoring seam never has to
widen.** The loop assembles a report as `architecture.md` §5.1 defines it —
ordered sections, model-chosen prose, verbatim transferred passages with
citations, graph traversal to locate rows, and an explicit unreachability note
when a section cannot be grounded.

The verbatim rule is the testable core and the reason to do this before the
export: **a transferred passage must be byte-identical to its stored chunk**,
because that is the provenance claim the product makes. Assert it directly by
re-fetching every cited `chunkId` from the store and comparing bytes — not
eyeballed.

_Version bump: MINOR._
_Exit: the MCP server is registered idempotently; an LLM assembles a report over a
populated evaluation, and every transferred passage is byte-identical to the chunk
it came from — asserted against the store, not eyeballed. A run with no graph
loaded returns a reported unavailability, not a silently thinner report._

### 3 — The report sheet seam

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

2. **Running a corpus from the browser is out of scope.** Choosing which
   documents of a connected bucket are in scope for an evaluation, and starting
   the pipeline over them, was a numbered item until it was descoped on
   2026-08-09. It is not deferred-and-scheduled: nothing in this file plans it.
   What that costs, stated plainly so it is not rediscovered as a surprise —
   `IngestDocuments`, `AssignDocumentsToGroups`, the cold-start classifier and
   `BuildEvaluationTable` stay reachable only from
   `apps/web/scripts/seed-redline-evaluation.ts`, so every evaluation begins with
   an operator at a terminal, and the object-storage port and adapter redline
   would need to upload or browse a bucket in TypeScript remain unwritten. The
   `evaluation` router's `create` mutation is unaffected: an evaluation is still
   created in the browser over an already-staged corpus.

3. **How a corpus reaches the bucket is written down nowhere, and no item owns
   writing it.** `two-stack-local-run.md` brings up MinIO and stops; `mc cp`
   stages the bucket in practice, which is a note to ourselves rather than a
   runbook. Whoever drives the next run writes that step first. This is the live
   gap left by the descoped browser-driven run, and it is also why
   `redline-create-evaluation.spec.ts` still needs an
   `E2E_REDLINE_STAGED_CORPUS_ID` staged by hand — one naming a corpus **no
   evaluation has claimed**, since `create` refuses a claimed one with
   `ALREADY_EXISTS`.

4. **The Playwright specs that need a populated evaluation are unrun**, and the
   reason is environmental, not a missing corpus: the UAT web container is a
   production install with dev dependencies pruned and no browsers. They need an
   `E2E_REDLINE_EVALUATION_ID` and a runner that has Playwright.

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
   ungrouped rows and is counted twice. Narrative ranges are handled. Fixing this
   properly is a womblex change, not a redline one; raise it upstream rather than
   inferring a grouping here from adjacency.

7. **Source comments cite ADR numbers, most of which no longer resolve.** Plan
   item citations are gone from source — do not reintroduce them. What remains is
   `ADR-00xx`, densely: `docs/adr/` holds four documents and the comments cite
   many more. Harmless where the comment states its own substance, which is the
   common case; fix opportunistically when touching the file rather than as a
   pass of its own. `grep -rn 'ADR-00' packages apps services` is the live answer;
   a count here would rot like everything else.

   Related and unresolved: `.claude/CLAUDE.md` and `design-principles.md` both
   record that ADRs were deliberately abandoned, yet `docs/adr/` has four written
   since. Either the deviation table is wrong or the ADRs are. Settle it.

---

## 5. Sequencing

**The lean vertical runs to completion before the housekeeping work starts.**

**The product items are the report assembly (fork-side) and the report sheet
seam, and nothing may gate them on a run.** Everything before them assembles
inputs; everything after them is proof or polish. They need rows in the store,
which can be seeded — so they start now. An earlier revision sequenced a fixture
run first on the reasoning that later items would then debug against known-good
connectors; in practice that only deferred the product behind a proof of the
plumbing, and the plumbing gap it was meant to catch — the absent money-span
writer — is one it could not have caught. That ordering is withdrawn.

Their prerequisites are met: the money-span write path is built, so spans reach
the store; the tool surface over them is built and served (`apps/redline-mcp`)
including graph traversal; and what a report is is settled (`architecture.md`
§5.1). So the fork-side assembly loop extends and registers rather than starting
from nothing. Nothing in the lean vertical waits on another item to start.

**The UAT gate is the report sheet seam.** A corpus rendering in a grid is a
demonstration of womblex and a classifier; a specialist cannot evaluate a tender
from it, and asking them to would test the wrong thing. The report items are what
make it redline.

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
