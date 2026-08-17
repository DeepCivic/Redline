Disregard and delete delivery plan and end to end corpus 

We need to deliver the below and it should be fairly lean to do. A surface in Wayfinder that reads Womblex outputs to support the below process.

# CorpusDocument-to-Report Extraction Engine

### Input
User defines report columns. Each column has:
- `name`
- `semantic description`
- optional `constraints` — financial or date (regex and enum are deferred to a later version)

## Run

1. User selects documents and starts the report run.

2. For each document:
   - Create exactly one report row.
   - Run one base LLM extraction call for that document.

3. The base LLM call:
   - Has access to chunk/structure-fetch tools, money-span tools, and one-hop graph
     lookup (`graph_find_entities`, `graph_edges_from`, `graph_edges_to`) for entity
     resolution — graph results are navigation pointers, not evidence.
   - Copies field values from relevant chunks where possible.
   - Returns one value per column, with a chunk citation as evidence if available.

4. Apply constraints:
   - If a field is marked financial or date, normalise it.
   - If normalisation or validation fails, mark that value `needs_review`.

5. Status handling:
   - Each value is one of: `verified`, `missing`, or `needs_review`.
   - Only `verified` values go into the final report.
   - `missing` and `needs_review` values are held back and flagged in the export for
     manual handling outside the product — there is no in-app approval workflow.

6. Export:
   - One row per document.
   - One column per field.
   - Flagged values are visible for review.

---

# Delivery detail

> Everything above this line is the product statement and is not edited. Everything
> below is the detail a session needs to build against it.

## 0. Status — read before anything else

**This file is the only live plan.** It superseded `docs/delivery-plan.md`,
`docs/design-principles.md` (both now deleted) and `docs/architecture.md` — including
§5.1 "What a report is", whose narrative-sections definition is replaced by the
column/row grid above. §10 itemises what is left to remove.

**The repo builds again (2026-08-17).** Three scope cuts in two days (`a018a2a`,
`2b7531d`, `59d4156`) removed the Evaluation surface, the corpus control plane, the
materialised store and the sheet renderer — *whole files only*, by design — and left
dangling barrels, an MCP container wiring deleted adapters, a sidecar `main.py`
importing deleted modules, stale manifests and dead `validate.sh` checks behind. Build
step 0a repaired all of it, but **not** the way originally scoped below (§9 0a's text
is left as the historical record of that scoping; see the decision row and the rewritten
0a outcome). `./validate.sh` is green.

**The seven deleted port contracts were not restored.** They were written before any
redline session had read a real womblex corpus, and restoring them verbatim would carry
that same guesswork forward under a green build that looks more finished than it is.
`report-tools.ts` was trimmed to the three tools its one surviving port
(`IProcurementExtractionReader`) actually backs — `fetch_chunks`,
`fetch_chunks_by_structure`, both money-span fetches and all three graph tools are
**gone**, not stubbed. §3.1 and §9 step 4 are rewritten to match. Redesigning the
chunk-store/money-span-store/graph-store contracts is **step 1**, and step 1 cannot
start until the user has supplied a real Womblex corpus sample — see the new step 0c.

**What survived is more useful than it looks.** `apps/redline-mcp/src/lib/report-tools.ts`
still holds the three extraction-reader tools — see §3.

### Decisions taken 2026-08-16

| Question | Decision |
|---|---|
| Where the base LLM extraction call runs | **redline** — not the fork, not the sidecar |
| Where definitions, runs, rows and values persist | **redline** — it re-owns a Postgres, for the report domain only |
| "corpus search, embeddings" in the base call | **Point-only for v1** — see §1.1 |
| How aggressive the removal itinerary is | **Extreme** — §10 |

### Decisions taken 2026-08-17

| Question | Decision |
|---|---|
| Summary generation | **Cut entirely.** No second LLM call, no chunk-read cache, no `generated` status, no `summaryGeneration` column flag |
| Interactive review grid | **Cut.** Replaced by a read-only sample table in the fork; no in-app approval workflow. The export is the review surface |
| Graph overlay | **Kept, narrowed to an extraction aid.** `graph_find_entities`/`graph_edges_from`/`graph_edges_to` for entity resolution and one-hop lookup only; graph output is a navigation pointer, never evidence — every value still cites a chunk |
| Constraints | **`financial` and `date` only for v1.** `regex` and `enum` deferred to a later version |
| Build step 0a scope | **Trash removal only — the seven deleted port contracts are not restored.** They were designed without a real womblex corpus to check them against; restoring them verbatim would launder that guesswork through a green build. `report-tools.ts` is trimmed to the three tools its surviving port backs, not stubbed back to ten |
| How step 1 gets unblocked | **The user supplies a real Womblex corpus sample.** New step 0c. The chunk/money-span/graph contracts, and the sidecar routes that back them, are designed against what a real `womblex run` actually writes — not re-derived from the deleted TypeScript a second time |

## 1.1 v1 scope: retrieval is point-only

The product statement says the base call has "corpus search, embeddings". **v1 gives it
neither.** The model is *pointed* at rows — structural fetch by document/page/content
type, and graph traversal from an entity to the chunk that mentions it — and never
discovers them by similarity. It transfers facts it is directed to.

This is a deliberate narrowing of the statement above, recorded rather than done
quietly. womblex writes `*.embeddings.parquet` (`store/output.py`, `EMBEDDINGS_SCHEMA`:
`source_hash`, `chunk_index`, `content_type`, `model`, `task`, `dim`, `vector`) and
ships **no index** — vectors sit on disk, nothing ranks them.

**Re-entry condition:** when a corpus is large enough that structural + graph pointing
demonstrably misses fields a human finds, build the search seam. It belongs sidecar-side
(query embed via Isaacus `kanon-2-embedder` at `task: retrieval/query`, cosine over the
corpus's vectors), because that is where the vectors already are. Do not build it before
a measurement says pointing is insufficient.

## 2. Data model

Destined for `packages/redline-domain`. Result pattern at every boundary; no throwing
across packages.

```ts
type FieldStatus = "verified" | "missing" | "needs_review";

type ColumnConstraint =
  | { kind: "financial"; currency?: string }
  | { kind: "date" };

interface ReportColumn {
  columnId: string;
  name: string;
  semanticDescription: string;
  constraint?: ColumnConstraint;
}

interface Evidence {
  documentId: string;   // womblex source_hash
  chunkId: string;      // "{source_hash}:{chunk_index}"
  quotedText: string;   // contiguous substring of that chunk — see §4
}

interface FieldValue {
  columnId: string;
  rawValue: string | null;        // as the model returned it, never rewritten
  normalisedValue: string | null; // constraint output; null when normalisation failed
  status: FieldStatus;
  evidence: readonly Evidence[];
  reason: string | null;          // why it is missing or needs review
}

interface ReportRow { documentId: string; values: readonly FieldValue[] }
interface ReportRun {
  runId: string; corpusId: string; definitionId: string;
  documentIds: readonly string[]; status: "pending" | "running" | "complete" | "failed";
}
```

`regex` and `enum` constraints are deferred to a later version (decided 2026-08-17) —
`financial` and `date` are the only two `ColumnConstraint` kinds for v1.

**`evaluationId` → `corpusId` happens here.** The ports and schema are being written
fresh, so this is the one moment the rename costs nothing. It was deferred before
because it spanned TypeScript, Python and SQL simultaneously; it no longer does. The
surviving `IProcurementExtractionReader`
(`packages/redline-domain/src/ports/procurement-extraction-reader.ts`) still takes
`evaluationId` and is renamed with it.

## 3. Architecture — where each piece lives

| Layer | Path | Role |
|---|---|---|
| Engine | `services/womblex` (submodule) | writes Parquet shards to object storage. Unchanged; never reimplemented |
| Read seam | `services/womblex-ingest` | Parquet → JSON. **Grows** run-scoped routes for documents, chunks, graph and money spans |
| Ports + types | `packages/redline-domain` | the §2 types, `IExtractionModel`, the corpus read ports |
| Implementations | `packages/redline-adapters` | Drizzle stores, the LLM client, sidecar HTTP readers |
| Tool surface | `apps/redline-mcp` | three extraction tools today; seven more rebuilt in step 4 against step 1's fresh contracts |
| Engine process | `apps/redline-report` (**new**) | the per-document loop; the HTTP API the fork calls |
| UI | `services/wayfinder` (fork) | column editor, document picker, run + progress, read-only sample table, export |

### 3.1 What's left, and what step 4 rebuilds

`apps/redline-mcp/src/lib/report-tools.ts` held all ten tools through 2026-08-16, but
0a (2026-08-17) deleted seven of them along with the ports they read — not just their
implementations, the tool definitions themselves — because those ports were Drizzle
readers over a schema this plan does not restore verbatim (see the 0a rewrite in §9).
What remains today:

- `read_extraction_elements`, `read_extraction_chunks`, `read_extraction_table_cells`
  — backed by `IProcurementExtractionReader`, the one port that survived 0a intact.

Deleted, to be rebuilt in step 4 against the fresh contracts step 1 designs:

- `fetch_chunks`, `fetch_chunks_by_structure`
- `fetch_money_spans_by_document`, `fetch_money_spans_by_structure`
- `graph_find_entities`, `graph_edges_from`, `graph_edges_to`

Their old shapes (descriptions, the stable-ordering contract, the `graphAvailable: false`
disambiguation between an empty traversal over a real graph and no graph loaded) are a
useful reference for what the product statement needs each tool to do, but not a
contract to restore verbatim — the 0c corpus sample is what step 1 checks the redesigned
shapes against.

### 3.2 One tool surface, two mounts

The engine binds `buildReportTools(...)` in-process and converts the `inputShape` zod
objects to the model's tool schema. `apps/redline-mcp` stays the external mount over
streamable HTTP. Neither is written twice, and a tool added for the engine is available
to an outside consumer for free.

## 4. The extraction call contract

One base call per document with the tools attached — never one call per column. That
keeps spend at M calls rather than N×M, and it is why evidence must be asked for
explicitly in the response shape: a per-column call would have carried the column
implicitly, and this does not.

Response: one object per column, `{ columnId, value, evidence[], absent, reason }`.

Three rules the model is never trusted on. The first two are carried verbatim from the
deleted `HttpAdjudicator`
(`git show 64bd20a^:packages/redline-adapters/src/adjudication/http-adjudicator.ts` —
its wire shape is the widely-implemented chat/completions JSON-mode contract, so any
OpenAI-compatible endpoint satisfies it without an adapter change):

1. **A column that was not offered is rejected outright.**
2. **Evidence citing a chunk no tool returned in this call is rejected outright.**
3. **`quotedText` must be a contiguous substring of the cited chunk** — checked
   mechanically after the call against the bytes the tool returned, never eyeballed.

Rule 3 is the provenance claim, restated for a grid instead of a narrative. A value
whose quote does not survive the substring check becomes `needs_review`. It is **never
dropped silently and never rewritten** — a silently reworded quote no longer resolves to
its source, which is the whole thing this product sells.

Graph tools (`graph_find_entities`, `graph_edges_from`, `graph_edges_to`) are scoped to
entity resolution and one-hop relation lookup — the base call may use them to locate a
chunk, never to source a value directly. A graph edge is a navigation pointer, not
evidence: every extracted value still carries a chunk citation, and that citation is
checked against rules 1–3 exactly as any other, regardless of whether the chunk was
found by direct fetch or graph traversal.

## 5. Constraints and normalisation

**financial — prefer a money span, do not parse a string.** Where the evidence anchors
to a womblex money span, use it. `MONEY_SPANS_SCHEMA`
(`/home/user/womblex/src/womblex/store/money_output.py`) carries an exact
`decimal128(38,4)` `value` with **sign and multiplier already folded in**, plus
`currency`, `currency_source`, `evidence`, `modifier` ("up to", "approximately" — left
unfolded deliberately) and the `range_group`/`range_role` pair linking a range's two
endpoints. Re-applying `multiplier` or `negative` to `value` double-counts; the schema
warns about exactly this.

Fall back to parsing a raw string only when no span anchors, and then through **one**
shared parser that preserves sign, disambiguates separators, and **refuses genuinely
ambiguous digit groupings rather than guessing**. This is the measured lesson of
findings F2/F3 in the (now-deleted) 2026-07-28 review: a parser that strips everything
outside `[0-9.]` turned `$1.234,56` into `1.23456`, `$1 234,50` into `123450.0`,
`-$500.00` into `500.0` and `($1,234.56)` into `1234.56` — a credit summed as a debit.
Two independent parsers is how that happened; do not build a second one.

- **date** — ISO 8601 out. AU day-first default. Ambiguous → `needs_review`.

Any normalisation failure yields `needs_review` with `rawValue` preserved beside it.

## 6. Statuses and the export surface

| Status | Means |
|---|---|
| `verified` | at least one evidence citation passed rule 3 and, if constrained, normalised cleanly |
| `missing` | the model returned nothing and said why |
| `needs_review` | evidence failed, normalisation failed, or a value came back with no evidence at all |

Only `verified` values reach the final report. `missing` and `needs_review` values are
held back and stay visible in the export — a blank cell and a withheld cell must never
look the same. There is no in-app approval workflow and no approval status: the export
is the review surface, and resolving a flagged value happens outside the product.

## 7. Export

Two formats: **CSV and XLSX**. One row per document, one column per field, flagged
values visible for review.

**XLSX reuses a shape; CSV does not exist yet.** `report-export.ts`
(`git show 2b7531d^:apps/redline-web/src/lib/report-export.ts`, 178 lines) is the writer
to carry forward — framework-free, unit-tested, already corpus-shaped (`corpusId`, not
`evaluationId`), and it already absorbed the browser writer. Its cell types were verified
against `write-excel-file@4.1.1`'s bundled `types/SheetData.d.ts`, so that verification
does not need redoing.

Do **not** reuse `excel-export.ts` (`git show 64bd20a^:…`, 220 lines): it is built on
`./review-grid` and `./pricing-pivot`, and the review grid is descoped (§0, 2026-08-17).
Its multi-sheet pivot output is a shape for a surface that no longer exists.

Neither deleted writer emitted CSV — both went straight to `.xlsx` via
`write-excel-file/browser`. CSV is additive work in step 9, not a recovery.

## 8. Known blockers

1. **A corpus run twice serves every document twice.** `RealWomblexExtractor.extract`
   (`services/womblex-ingest/src/womblex_ingest/real_extractor.py`) lists the whole
   `proc/{corpusId}/` prefix and concatenates by suffix, merging every run under it;
   `elementOrder` then identifies nothing. The engine lands each run under
   `proc/{corpusId}/runs/{runId}/documents/`. **Every read route this plan adds must be
   run-scoped**, and the existing one must be fixed. No report row is trustworthy until
   it is — a document silently doubled produces doubled evidence and plausible,
   wrong values.
2. ~~The tree does not build~~ **Resolved 2026-08-17** (§0, build step 0a) — `./validate.sh`
   is green. Resolved by deletion, not restoration: the seven corpus-read ports and seven
   of the ten report tools are gone, pending the redesign step 1 does once step 0c lands
   a real corpus sample.
3. **The fork half is unlanded.** The gitlink is stale at `5d236db1`. `validate.sh` #12
   *skips* while the submodule is unpopulated and only bites once it is initialised —
   so a green-looking run on a fresh clone proves nothing about the pin. Two prior fork
   changes must fold into one commit, not land separately.
4. **Submodules are unpopulated in a fresh session.** `git submodule status` shows both
   `services/wayfinder` and `services/womblex` uninitialised, so the fork's structure is
   unverified until `git submodule update --init` runs. The fork step begins by
   reading it, not by assuming its shape.

## 9. Build steps

One commit each, tests-first, **≤500 changed lines**, with an explicit exit test. A step
whose exit test joins two independently-testable behaviours is two steps.

0a. ~~**Remediate to green (verbatim restoration).**~~ **Superseded 2026-08-17, landed as
    trash removal instead.** The text below is kept as the historical record of how this
    step was originally scoped, not as what shipped — see the decision row above.

    <details>
    <summary>Original scoping (not what landed)</summary>

    `delivery-plan.md` is deleted, so its §0.3 list is inlined here rather than cited
    (`git show 333e6d1:docs/delivery-plan.md` for the original):

    - **Domain barrel** — dangling `export *` for seven deleted ports.
    - **Adapters barrel** — dangling exports at the run-trigger, money-span, chunk-store,
      chunk-element, graph-store, staged-corpus-reader, storage and
      `db`/`applyMigrations` blocks.
    - **Restore the seven corpus-read port interfaces** in `redline-domain`, verbatim from
      git — interfaces only, zero implementations — so `report-tools.ts` keeps all ten
      tools and type-checks. Step 1 renames `evaluationId` → `corpusId` across them; step 4
      lands their sidecar-backed implementations. This is why 0a is not purely
      subtractive: the tools cannot compile against nothing.
    - **`apps/redline-mcp`** `container.ts` + `mcp-server.ts` — drop the deleted Drizzle
      bindings. A tool whose dependency is unbound stays defined but unregistered (the
      `graphAvailable: false` degradation already models this); step 4 binds them.
    - **Sidecar `main.py`** (+ `test_ingest_api.py`) — remove the `/runs` and
      `/embeddings` routes, the chunk-store load on `POST /ingest`, and the Postgres
      wiring. Keep `/health`, `/ingest`, `/status`, `/extractions`.
    - **Sidecar `records.py`** — embedding DTOs go, extraction DTOs stay.
    - **Manifests** — `minio` and the `@rbrasier/domain` optional dependency leave
      `redline-adapters`; `@redline/redline-shared` and `@redline/redline-web` leave the
      workspace, `tsconfig.json` and the fork's `apps/web/package.json`.
    - **`validate.sh`** — retire #5, #10 and #13; `pnpm-workspace.yaml`'s
      `vendor/wayfinder` glob goes with them.
    - **Infra** — the `ingest` / `money` / `stage` / `redline` compose profiles; `report`
      is the profile that describes the stack.

    Three items in the original §0.3 were to be overridden and not carried across: its
    item 3 trimmed `report-tools.ts` to three tools and deleted seven — this doc's §3.1
    said keep all ten and re-point them. Its item 7 dropped `drizzle-orm`, `postgres`,
    `drizzle-kit`, `@electric-sql/pglite` and the `db:*` scripts for step 2 to reinstate.
    Its item 8 retired `validate.sh` #6 (Drizzle table naming) for step 2 to make live
    again.
    </details>

    **What actually landed:** pure deletion, nothing restored. The domain and adapters
    barrels were trimmed to export only what still exists — `redline-domain` now carries
    just `IProcurementExtractionReader`; `redline-adapters` just `WomblexExtractionReader`.
    `report-tools.ts` was trimmed to the three tools that port backs
    (`read_extraction_elements/chunks/table_cells`) — `fetch_chunks`,
    `fetch_chunks_by_structure`, both money-span fetches and all three graph tools are
    **deleted**, not stubbed, along with their tests. `container.ts` dropped its
    `REDLINE_DATABASE_URL` requirement and all Drizzle wiring — nothing in `redline-mcp`
    touches Postgres any more. Sidecar `main.py`/`records.py`/`extraction.py`/
    `shard_reader.py`/`real_extractor.py`/`config.py` had every reference to the deleted
    `chunk_store`/`embedding`/`run_trigger`/`money_span_store` modules removed (the
    embeddings/query-embedding capability chained through five files via a module that no
    longer existed) — kept to `/health`, `/ingest` (shards + JSON extraction, no store
    projection), `/status`, `/extractions`. Manifests, `drizzle.config.ts`, the
    `pnpm-workspace.yaml` vendor glob, `validate.sh` #5/#10/#13, the orphaned
    `infra/docker-compose.run-sidecar.yml`, and the broken `infra/docker/
    womblex-money.Dockerfile` reference in `infra/docker-compose.yml`'s `money`/`stage`
    services were all removed rather than repaired, since nothing implemented what they
    configured. `.github/workflows/ci.yml` had the same rot (a `scripts/vendor-wayfinder.sh`
    step that would fail every run) and was fixed alongside.

    Why not restore verbatim: the seven contracts were authored before any redline
    session had read a real womblex corpus. A green build over restored-but-unverified
    shapes would look more finished than the store actually is. Redesigning them against
    real data is step 1, gated on step 0c.
    _Exit: `./validate.sh` green — met 2026-08-17, without restoring the seven ports._
0b. **Legacy removal.** The full §10 itinerary (docs, code, config) — its own commit
    (or several, one per §10 subsection, if the diff runs past the ≤500-line cap on a
    single one), separate from 0a because a green build and a clean tree are two
    independently-testable outcomes. Still outstanding — 0a landed as trash removal, not
    the full §10 sweep; `docs/architecture.md` and the other §10 documents are still
    present.
    _Exit: every path listed in §10 is gone and no reference to a removed symbol
    remains (`grep` clean for each removed export/route/profile)._
0c. **Sample corpus handoff.** The user supplies a real Womblex corpus — documents staged
    through the engine and drained at least through `chunk` (further through `enrich` and
    `money` if graph/financial contracts are to be designed against real spans too), so
    its actual Parquet shards (`manifest.parquet`, `CHUNKS_SCHEMA`, `GRAPH_EDGE_SCHEMA` +
    `ENTITY_SCHEMA`, `MONEY_SPANS_SCHEMA`) are on disk or in object storage where a
    session can read them. This is not optional groundwork: it is what step 1 designs
    the seven port contracts *against*, replacing the deleted, never-verified shapes 0a
    declined to restore. No contract work starts without it.
    _Exit: a named corpus location (path or bucket prefix) with at least the `chunk`
    stage's shards present, that a session can point a schema-design pass at._
1. **Report domain.** The §2 types, `IExtractionModel`'s signature, and the report ports.
   The seven corpus-read ports removed in 0a (chunk-store, money-span-store, graph-store,
   staged-corpus-reader/writer, womblex-run-trigger, run-config-override) are **designed
   fresh against the 0c corpus sample**, not restored from git — their prior shapes are
   history, not a starting draft. No `summaryGeneration` column flag, no `generated`
   status. `evaluationId` → `corpusId` is the naming convention for every new port, not a
   rename of anything that still exists.
   _Exit: a conformance fake satisfies every port, each checked against the 0c sample's
   actual schema; Result shape holds at each boundary._
2. **Persistence.** redline Postgres schema + forward-only migration `0000` +
   Drizzle stores for definitions, runs, rows and values. `redline_` prefix, snake_case.
   _Exit: a definition and a run round-trip; a re-applied migration is a no-op._
3. **Sidecar run-scoped read routes.** Documents (from `manifest.parquet`:
   `source_hash`, `doc_id`, `filename`, `status`), chunks (`CHUNKS_SCHEMA`:
   `source_hash`, `chunk_index`, `text`, `start_char`, `end_char`, `content_type`,
   `has_redaction`, `page_start`, `page_end`, `elem_order`), graph (`ENTITY_SCHEMA` +
   `GRAPH_EDGE_SCHEMA`), money spans (`MONEY_SPANS_SCHEMA`). Fixes blocker 1.
   _Exit: a corpus with two runs serves each document once, from the named run._
4. **Sidecar-backed adapters + in-process tools** implementing the ports step 1 designed.
   The seven `report-tools.ts` tools 0a deleted (`fetch_chunks`,
   `fetch_chunks_by_structure`, both money-span fetches, all three graph tools) are
   **rebuilt against the step 1 contracts**, not "re-pointed" — there is nothing left
   pointing anywhere.
   _Exit: all ten tools answer against a sidecar fixture, ordering stable; graph tools
   resolve entities and one-hop edges only._
5. **The `IExtractionModel` seam** and its three rejection rules.
   _Exit: an unoffered column, a fabricated chunk id and a non-substring quote are each
   rejected; the wire shape is asserted against a fake, not a live endpoint._
6. **The per-document loop.** One base call, evidence verification, status assignment.
   _Exit: one document yields one row with a status — `verified`, `missing`, or
   `needs_review` — on every column._
7. **Constraint normalisers**, money-span-first (§5), financial and date only.
   _Exit: the F2 table (`$1.234,56`, `$1 234,50`, `-$500.00`, `($1,234.56)`) parses
   correctly or refuses; no case guesses._
8. **`apps/redline-report`** process + wiring in `lib/container.ts`.
   _Exit: define columns, start a run, poll, fetch rows over HTTP._
9. **Export** — CSV and XLSX, flagged values visible (§7).
   _Exit: a run with one `needs_review` value exports it visibly, not blank, in both
   formats._
10. **The fork surface** — two commits: the fork PR merged to `main`, then the gitlink
    bump. Folds in the unlanded fork work (blocker 3). Column editor, document picker,
    run + progress, read-only sample table, export.
    _Exit: the served route drives a run end to end; the sample table renders rows
    read-only, with no approval action present._

## 10. Removal itinerary — #noLegacyShit

Before deleting the docs below, three things in them are worth keeping and are already
carried into this file: the money-parse lesson (§5), the `proc/` prefix bug (§8.1) and
the verbatim/provenance rule (§4, rule 3). The duplicate-summarisation cost the deleted
2026-07-28 review measured no longer applies — summary generation is descoped entirely,
not merely relocated. Nothing else in them survives the cuts.

### Documents — delete outright

Three are **already deleted** (2026-08-17, deliberately, ahead of 0b): `delivery-plan.md`
(240 lines), `design-principles.md` (141) and `NEXT-STEPS-create-corpus-e2e.md` (252).
`delivery-plan.md` §0.3 is already folded into step 0a above, so nothing is owed to it.
Their references from `.claude/CLAUDE.md` are live danglers — that file's edit is listed
below and now blocks nothing else.

Outstanding:

| Path | Lines | Why it is legacy |
|---|---|---|
| `docs/architecture.md` | 952 | describes a store, control plane and sheet renderer that are deleted; §5.1's report definition is superseded by the grid above |
| `docs/guides/create-a-corpus.md` | 195 | documents the deleted Create Corpus UI |
| `docs/guides/two-stack-local-run.md` | 190 | drives deleted services and profiles |
| `docs/reviews/2026-07-28-technical-review.md` | 310 | reviews Numbatch, the Evaluation repository and the lens — all deleted |

Keep `docs/guides/local-dev-and-validation.md`, minus its vendoring section.

### Code and configuration

- **Barrels** — dangling `export *` lines in `packages/redline-domain/src/index.ts` and
  `packages/redline-adapters/src/index.ts`.
- **Sidecar** — the `/runs`, `/runs/{id}/resume` and `/runs/{id}` routes plus `runs.py`;
  both `/embeddings` routes; the Postgres wiring on `POST /ingest`; the embedding DTOs
  in `records.py`.
- **`packages/redline-adapters`** — the `minio` dependency and the `@rbrasier/domain`
  optional dependency. **`drizzle.config.ts` and the Drizzle dependencies stay** —
  Postgres returns for the report domain (step 2), which also makes `validate.sh` #6
  (table naming) live again rather than a removal candidate.
- **Workspace** — `pnpm-workspace.yaml`'s `vendor/wayfinder/packages/*` glob and its
  comment block, now that `scripts/vendor-wayfinder.sh` is deleted.
- **`validate.sh`** — #5 (vendor not committed) and #10 (lockfile rewritten by an
  unvendored install) police vendoring that no longer happens. **#13 is not merely
  subjectless, it fails now**: it greps `infra/docker/womblex-money.Dockerfile` for
  `ARG EXTRAS=`, and that Dockerfile was deleted in `59d4156`, so the check takes its
  fail branch on every run. **#6 and #12 stay.**
- **`infra/docker-compose.yml`** — the `ingest`, `money`, `stage` and `redline` profiles
  and the `money` + `stage` services. `redline-postgres` **returns**, under `report`.
- **`infra/docker-compose.run-sidecar.yml`** — orphaned twice over: it builds from the
  deleted `infra/docker/womblex-money.Dockerfile` and exists to run `run_trigger.py`,
  which went with the control plane. It goes with `validate.sh` #13.
- **`infra/uat`** — `REDLINE_ADJUDICATOR_*` becomes the extraction model's config; the
  Create Corpus env notes and the run-sidecar comment go.
- **`scripts/thread-03-smoke.sh`** — drives the `ingest` profile and `POST /ingest`,
  both removed. **`scripts/womblex-engine-smoke.sh` stays** — it stages a corpus and
  drains the engine through its own CLI, which is how a corpus is made now.
- **`.claude/CLAUDE.md`** — the `redline-web` references, `scripts/vendor-wayfinder.sh`,
  the migrations rule tied to the deleted schema, and the E2E deviation row with its
  three Create Corpus paragraphs.
- **`ADR-00xx` comments** — across `packages/`, `apps/`, `services/`, `infra/`. The
  register is abandoned and settled as such; 22 files still carry citations that resolve
  to nothing (`grep -rln 'ADR-00' packages apps services infra`). Read a surviving number
  as a pointer into git history until it is removed, except where it is plainly
  upstream's — womblex's own register does still exist.
- **Fork** — `corpus.ts`, `container-redline.ts`, the `/create-corpus` route and its e2e
  spec, the sidebar entry and the `corpus:create` permission.

## 11. Open questions

1. **Does `apps/redline-mcp` survive as a process, or only as the in-process tool
   library?** It costs a Dockerfile, a compose profile and a container, and the engine
   does not need it — §3.2 binds the tools directly. It is worth keeping only if an
   outside consumer wants them. Decide at step 8, not now.
2. **Which model backs `IExtractionModel`.** The UAT stack ships Wayfinder's own
   provider set (`AI_DEFAULT_PROVIDER: anthropic`, plus OpenAI/Mistral/Groq/Bedrock keys
   and Langfuse) and redline's own `REDLINE_ADJUDICATOR_*` pair defaulted to Groq.
   redline now owns the call, so it owns the choice — but pointing at Langfuse for
   observability is close to free.
