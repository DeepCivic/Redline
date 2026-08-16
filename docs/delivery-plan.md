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

## 0. What redline is now (READ FIRST)

**redline is a corpus-ingest-and-report substrate.** A specialist stages a corpus
from the browser, womblex extracts/chunks/embeds/enriches/prices it, and the
chunks, graph, money-spans and extraction JSON that run lands serve two
independent consumers — the fork's Create Corpus UI and `apps/redline-mcp`'s
report tools. There is no Evaluation aggregate, no classification/adjudication/
lens stack, no review grid, no pricing pivots and no Numbatch dependency.

The Evaluation surface was deleted on 2026-08-15 and the references it left
behind were removed on 2026-08-16. **Both repos build, lint and test green
again**; `architecture.md` and `design-principles.md` describe the substrate, not
the adapter that preceded it. The deleted code is in git history — reaching for it
means designing afresh above the store, not restoring an aggregate.

---

## 1. The build-step contract

- One build step including its test. If the exit test needs two unrelated things
  built first, it is two steps.
- One agent, one context. One commit. A PR only on explicit request.
- Tests-first: the test file is written before the implementation file.
- One package where possible.
- **A fork-side step is two commits, not one** — one in `services/wayfinder`,
  one here moving the gitlink onto it. That is how gitlinks work, not a policy.
  What *is* a policy: `validate.sh` #12 fails unless the submodule sits on the
  fork `main`'s commit, so a fork feature branch cannot be pinned — it must merge
  there first. Plan the fork PR as part of the step, or the second commit cannot
  be made.

---

## 2. Outstanding

In dependency order.

### 2.1 Land the fork half

The fork-side removal is written and green (`apps/web` typechecks, lints and its
own vitest suites pass) but **not pushed**: it was produced in a session
authorised for `deepcivic/redline` only, so `johntooth/wayfinder` refused the
push. Until it lands the gitlink cannot move, and it deliberately still points at
the *pre-remediation* fork commit `5d236db1` on branch
`claude/create-corpus-post-run-25j23d`.

| # | What |
|---|---|
| 1 | Push the fork branch (`claude/remove-evaluation-references-yegtgz`) to `johntooth/wayfinder`, merge it to `main`. |
| 2 | Re-point `services/wayfinder` at the merge commit. Until then `validate.sh` #12 fails by design — the checkout is not on the fork's `main`. |
| 3 | Rewire `ReportAssembler` (`packages/adapters/src/mcp/report-assembler.ts`). It is built and tested but currently unwired: its `ChunkStoreReportVerifier` went with the Evaluation deletion, and `container-redline.ts` no longer supplies a `reportChunkVerifier`. Rewiring it belongs with the report work — it is the surviving product surface, not dead code. |

**What the fork change contains**, so a reviewer is not re-deriving it: the
`evaluation` tRPC router becomes `corpus.ts` (`staged` / `stagedDocuments` /
`create` / `runStatus` / `resumeRun`); `container-redline.ts` trims to the three
surviving ports; `evaluation:review` is deleted and `evaluation:create` becomes
`corpus:create` (verified 1:1 — the surviving surface is exactly what
`evaluation:create` already gated); the sidebar loses its Evaluations entry; and
Create Corpus loses its "Compose the evaluation" CTA, stating the corpus is
readable instead.

### 2.2 Rename `evaluationId` → `corpusId`

**The identifier still says `evaluation`, and it names a corpus.** It always did —
`architecture.md` §3 records the identity — but the word now points at nothing.
The rename is deliberately its own step because it is a coordinated change across
three languages and a live wire contract, not a find-and-replace:

- **SQL** — `evaluation_id` on `redline_chunks`, `redline_money_spans`,
  `redline_graph_entities` and `redline_graph_edges`, each in a composite primary
  key or an index. A forward-only `ALTER … RENAME COLUMN` migration, guarded so it
  is idempotent like every other migration here.
- **Python** — the sidecar's `REDLINE_CHUNK_STORE_DDL` and the three load paths
  (`chunk_store_postgres.py`, `money_span_store_postgres.py`, the graph load) must
  move in the same commit as the migration, or a load writes to a column that no
  longer exists.
- **The wire** — `POST /runs {evaluationId}`, `GET /runs/{runId}`'s
  `evaluationId`, and `/extractions/{evaluation_id}/{document_id}`. Renaming the
  JSON key is a breaking change to the sidecar contract, so the sidecar and the
  `HttpWomblexRunTrigger` / `WomblexExtractionReader` adapters move together.
- **TypeScript** — the port signatures, the Drizzle schema fields, the fork's
  `RunStatusViewModel.evaluationId` and the DOM that binds it.

The object-store prefix stays `proc/{id}/` — it is womblex's layout, and the
segment is already just an id.

### 2.3 Select a run when reading shards

`architecture.md` §5 invariant 7 records this and it is **still violated**:
`RealWomblexExtractor.extract` lists the whole `proc/{corpusId}/` prefix and
concatenates by suffix, so a corpus that has been run twice serves every element
twice and `elementOrder` no longer identifies one element. The run id is the
selector; `run-stage` already takes `--run-id` and every read seam needs the same.

---

## 3. Housekeeping — off the vertical, wanted before users

| Item | Package(s) | Notes |
|---|---|---|
| Raw-bucket browse | domain + adapters | Listing raw objects a run has not processed, so a picker can select from what is already staged rather than only upload. Deferred with the document-selection work. |
| Vector similarity search | adapters | The `pgvector`/ANN index behind `IChunkStore.findSimilar`, which refuses with `NOT_IMPLEMENTED` today. The embeddings are already loaded and addressable; what waits is the index over them. |
| Synthesis document picker | fork | Let Wayfinder's own "Synthesise Information" flow select documents from an existing corpus rather than only upload. The leaner change is "from a corpus" — it reuses the `IStagedCorpusReader` this repo already leans on, over documents that already carry stable `source_hash` identities. Ordinary fork work; the one caution is that a change touching `@rbrasier/domain` brings the contract test and gitlink bump in step. |
| Workspace extraction & release prep | workspace | Standalone workspace; sever the vendoring seam. Last by nature. |

---

## 4. Open questions

1. **A range inside a pricing *table* is still uncountable, and that is
   upstream's.** `money_stage.py`'s `_cell_row` attaches no
   `range_group`/`range_role` to cell spans at all, so "$1M–$2M" written in a
   pricing schedule arrives as two ungrouped rows. Narrative ranges carry the
   grouping. Re-checked against womblex 0.4.0 (`d6850de`, the narrative-money
   release): `_cell_row` still neither accepts nor sets those fields, so the bump
   does not close this. Fixing it properly is a womblex change; raise it upstream
   rather than inferring a grouping here from adjacency.

2. **Source comments cite ADR numbers, none of which resolve.** `ADR-00xx`
   remains across `packages/`, `apps/`, `infra/` and `scripts/`. Harmless where
   the comment states its own substance, which is the common case; fix
   opportunistically when touching the file rather than as a pass of its own.
   `grep -rn 'ADR-00' packages apps services infra scripts` is the live answer.
   Read a surviving number as a pointer into git history, except where it is
   plainly upstream's — Wayfinder's and womblex's own registers do still exist.

   **Settled: ADRs stay abandoned.** Decisions are recorded in the commit that
   acts on them; a decision durable enough to govern many commits goes to
   `design-principles.md`. Do not open `docs/adr/` again.

3. **Raw-corpus intake has two paths; both the direct and the UI-write path
   exist.** Direct-to-bucket works: an S3 client (`mc cp`, or any uploader) writes
   the raw documents under `proc/{corpusId}/` in redline's bucket — the seam is
   plain S3, redline builds nothing for it, and the path is documented in
   `docs/guides/two-stack-local-run.md`. The **via-UI write** path is built
   (`IStagedCorpusWriter`, driven by the Create Corpus tab); the **browse/select**
   half is deferred (§3).

---

## 5. Sequencing

**The order is: land the fork half (§2.1) → the `corpusId` rename (§2.2) → the
run-id selector (§2.3) → housekeeping in dependency order → workspace extraction
and release.**

The ingest surface, the run trigger/status seam, the shard load on completion,
the first-run OCR config, semantically bounded chunks (on by default, and
nameable per-run from Create Corpus), chunk element addressing and the report
tool surface are all built.

---

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
  read by embed, enrich and the report tools be semantically bounded — a
  480-token budget split puts deterministic money figures in incoherent context,
  which defeats the reason the money pass exists.

- **Browser-driven run was descoped (2026-08-09), and that is retired
  (UAT).** The descope read: running a corpus from the browser is out of scope,
  not deferred — nothing planned it, and every corpus began with an operator at a
  terminal driving a seed script. Its stated cost was the
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
  removed from `validate.sh` ("policed a relationship we do not have").
  Modifying the fork's own features (e.g. the synthesis document source) is
  ordinary fork work under the two-commit rule; the only live caution is that a
  change to `@rbrasier/domain`'s shape brings the contract test along with the
  gitlink bump.

### What this substrate deliberately does not do

- **No classification.** No trained classifier, no samples, no adapter, no
  cold-start pass. redline serves rows; deciding what they mean is a consumer's.
- **No Numbatch stack.** The submodule and redline's `numbatch-extension` overlay
  were removed, not deferred.
- **No comprehension lens.** Collisions, boundary decisions, lens authoring and
  portability are gone with it — see `design-principles.md` §2 for why re-entry
  would be a new design rather than a restoration.
- **No vector *similarity search*.** The `pgvector`/ANN *index*, `findSimilar` and
  the store-side query-embed path are deferred (§3). The embeddings *are* loaded
  and available; what waits is the nearest-neighbour index over them. Per the
  runtime rule above, this defers an index — it does not shrink the tool surface
  built over retrieval.
- **No workspace extraction.** Ship-shape is a later concern than see-shape.

`linking` stays off deliberately and is not the same thing as enrichment: `link`
writes `*.entity_links.parquet`, which nothing in redline reads, and its preflight
hard-fails without a `linking.reference` register a tender corpus has no candidate
for. Enrichment itself is **on**.
