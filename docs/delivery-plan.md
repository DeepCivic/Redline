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

## 0. Scope cut to the MCP tools — outstanding remediation (READ FIRST)

**redline was cut back to the MCP report tools plus the Wayfinder deployment
scaffolding on 2026-08-16**, in two steps the same day, after the Evaluation
surface went the day before. Only *whole* files were removed at each step; every
change needing a surgical edit was deliberately left, and is listed here.

> **The repo does not build in this state.** Barrels, the MCP container, the
> sidecar's `main.py` and four manifests reference deleted modules. This is a
> known, recorded mid-cut state, not a regression to bisect.

### 0.1 What redline is after this

**The MCP report tools over womblex extraction, and the scaffolding that deploys
them into Wayfinder.** Concretely:

- `apps/redline-mcp` — the tool surface, served over streamable HTTP, plus its
  Dockerfile and the `report` compose profile.
- `services/womblex-ingest` — the read sidecar: it reads the engine's Parquet
  shards from object storage and serves elements, chunks and table cells as JSON.
- `packages/redline-domain` — `Result`, `DomainError` and one port,
  `IProcurementExtractionReader`.
- `packages/redline-adapters` — `WomblexExtractionReader` over that seam, and its
  wire narrowing.
- `services/wayfinder` (submodule), `infra/`, `validate.sh` — the deployment
  scaffolding.

**Three tools survive, not ten.** `read_extraction_elements`,
`read_extraction_chunks` and `read_extraction_table_cells` read through the
sidecar. The other seven — both chunk fetches, both money-span fetches and all
three graph traversals — were Drizzle readers over the store, and went with it.
That includes `fetch_chunks`, the byte-identity re-fetch the provenance claim
rested on.

### 0.2 What was deleted

| Deleted | Also gone, as a consequence |
|---|---|
| The corpus control plane — `apps/redline-web` in full, `MinioStagedCorpusWriter`, `HttpWomblexRunTrigger`, the sidecar's `run_trigger.py`, and the writer / run-trigger / config-override ports | Starting or watching a run from a browser. A corpus is made from a terminal, driving the engine's own CLI. |
| The materialised store — the whole `persistence/` layer (four store adapters, the schema, all eight migrations), the chunk / money-span / graph / staged-corpus-reader ports, and the sidecar's two load paths | Seven of the ten MCP tools. redline no longer owns a Postgres. |
| The report sheet renderer — `report-export.ts` and the `AssembledReport` shape | The workbook a specialist received. Nothing in redline renders a report. |
| The money stage — the sidecar's `money_stage.py` and its Dockerfile | The `money` compose profile has no entrypoint. Money spans are neither produced nor read. |
| The embedding seam — the sidecar's `embedding.py` and the two `/embeddings` routes | The query-embed path. Nothing consumed it once the store went. |
| `packages/redline-shared` — a three-line placeholder no code imported | — |
| The Wayfinder typed-reuse seam — `wayfinder-contract.ts` and `scripts/vendor-wayfinder.sh` | `@rbrasier/domain` has no consumer, so `vendor/wayfinder` need not be materialised. This is **build-time typed reuse**, not the deployment scaffolding, which stays. |

### 0.3 Outstanding remediation, in dependency order

| # | Where | What is left |
|---|---|---|
| 1 | `packages/redline-domain/src/index.ts` | Dangling `export *` lines for the seven deleted ports. |
| 2 | `packages/redline-adapters/src/index.ts` | Dangling exports at the run-trigger, money-span, chunk-store, chunk-element, graph-store, staged-corpus-reader, storage and `db`/`applyMigrations` blocks. |
| 3 | `apps/redline-mcp/src/lib/report-tools.ts` (+ test) | Mixed file — trim to the three extraction tools; the four store dependencies and seven tools go. |
| 4 | `apps/redline-mcp/src/lib/mcp-server.ts`, `container.ts` (+ tests) | Same: drop the store wiring, keep the extraction reader. |
| 5 | `services/womblex-ingest/src/womblex_ingest/main.py` (+ `test_ingest_api.py`) | Mixed — remove the `/runs` and `/embeddings` routes, the chunk-store load on `POST /ingest`, and the Postgres wiring. Keep `/health`, `/ingest`, `/status` and `/extractions`. |
| 6 | `services/womblex-ingest/src/womblex_ingest/records.py` | Mixed — the embedding DTOs go, the extraction ones stay. |
| 7 | Manifests | `drizzle-orm`, `postgres`, `minio`, `drizzle-kit`, `@electric-sql/pglite`, the `db:*` scripts and the `@rbrasier/domain` optional dependency leave `redline-adapters`; `@redline/redline-shared` and `@redline/redline-web` leave the workspace, `tsconfig.json` and the fork's `apps/web/package.json`. |
| 8 | `validate.sh` | Check 5 (no committed Wayfinder source), check 6 (Drizzle table naming), check 10 (the lockfile's vendored importer) and check 13 (the run-sidecar's `isaacus` extra) all police things that no longer exist. `pnpm-workspace.yaml`'s `vendor/wayfinder` glob goes with them. |
| 9 | Fork | `corpus.ts`, `container-redline.ts`, the `/create-corpus` route and its e2e spec, the sidebar entry and `corpus:create` all mount a control plane that is gone. **This compounds with the still-unlanded fork change** below. |
| 10 | Infra | The `redline-postgres` service and the `ingest` / `money` / `stage` / `redline` compose profiles no longer describe the stack. The `report` profile is the one that still does. |
| 11 | Docs | `architecture.md` and `design-principles.md` describe a substrate these cuts removed. Both need rewriting or retiring — the direction has moved twice in two days, so retiring may be cheaper than a third pass. |

### 0.4 Still unlanded from the first cut

The fork-side Evaluation removal is written and green but was never pushed —
`johntooth/wayfinder` was outside the authoring session's repository scope. The
gitlink still points at `5d236db1`, and `validate.sh` #12 fails by design. Item 9
above invalidates most of that change, so **do not land it separately**: fold the
two into one fork commit.

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

**All outstanding work is the remediation in §0.3.** Nothing else is tracked:
every item this file carried before the cuts — the `corpusId` rename, the run-id
selector, raw-bucket browse, the vector similarity index, the synthesis document
picker — was work on a surface that has since been deleted. They are not deferred;
they have no subject. Reaching for any of them means designing afresh.

The one piece of history worth keeping in front of a reader: **`RealWomblexExtractor`
lists the whole `proc/{corpusId}/` prefix and concatenates by suffix**, so a corpus
run twice serves every element twice and `elementOrder` no longer identifies one
element. That still bites on the surviving extraction path.
`architecture.md` §5 invariant 7 records it.

---

## 3. Open questions

1. **Source comments cite ADR numbers, none of which resolve.** `ADR-00xx` remains
   across `packages/`, `apps/` and `infra/`. Harmless where the comment states its
   own substance, which is the common case; fix opportunistically when touching the
   file rather than as a pass of its own.
   `grep -rn 'ADR-00' packages apps services infra scripts` is the live answer.
   Read a surviving number as a pointer into git history, except where it is plainly
   upstream's — Wayfinder's and womblex's own registers do still exist.

   **Settled: ADRs stay abandoned.** Decisions are recorded in the commit that acts
   on them; a decision durable enough to govern many commits goes to
   `design-principles.md`. Do not open `docs/adr/` again.

2. **Whether `architecture.md` and `design-principles.md` survive at all.** Both
   describe a corpus-ingest-and-report substrate that no longer exists, and the
   direction moved twice in two days. A third rewrite is only worth it if the
   current shape is settled; otherwise retire them and let this file plus the
   READMEs carry what is true. Recorded as a question because it is a call for
   whoever picks this up, not a task to execute blind.

---

## 4. Sequencing

**The order is: the §0.3 remediation, in the order it is listed → decide the
documents' fate (§3.2) → nothing else is planned.**

The remediation is one pass, not a programme: it is barrels, a tool surface, a
FastAPI module, four manifests and four `validate.sh` checks. The fork half (§0.3
item 9) is the only part needing a second repository, and it must be folded with
the unlanded change described in §0.4 rather than merged after it.

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

### What redline deliberately does not do

- **No classification, no comprehension lens.** Removed 2026-08-15. See
  `design-principles.md` §2 for why re-entry would be a new design.
- **No store of its own.** redline owns no Postgres. Every read goes through the
  sidecar to the engine's shards in object storage.
- **No control plane.** A corpus is made by driving womblex's own CLI, not from a
  browser.
- **No report rendering.** redline serves extraction facts; assembling and
  rendering a report is a consumer's job, above these tools.
- **No embeddings, no similarity search, no money spans.** All three were surfaces
  over the deleted store.

`linking` stays off deliberately and is not the same thing as enrichment: `link`
writes `*.entity_links.parquet`, which nothing in redline reads, and its preflight
hard-fails without a `linking.reference` register a tender corpus has no candidate
for.
