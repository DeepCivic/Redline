# redline — Delivery Plan (live)

> **Status:** the live tracking document · **Date:** 2026-07-27
>
> **This tracks outstanding work. It does not restate design.**
> [`architecture.md`](./architecture.md) is the single source of truth for *what
> redline is and how data moves through it*; [`adr/`](./adr/) holds the decisions.
> This file holds *what is left to do* and nothing else.
>
> **Supersedes** `dev-iteration-3.md`, which is deleted along with
> `dev-iteration-1.md`. [`dev-iteration-2.md`](./dev-iteration-2.md) is retained
> as frozen design rationale — the D1–D13 register and the three findings behind
> the lens architecture — and tracks nothing. That resolves a standing conflict in
> which `architecture.md` and `dev-iteration-3.md` each claimed to be the single
> source of truth.

---

## 1. What changed, and why this document exists

Two things forced a revision of the plan:

1. **Decision D14 — both upstream engines are consumed as submodules, and their
   existing capabilities are used in preference to rebuilding them.** Threads 37a
   onward were authored *before* this decision. They assumed redline would supply
   its own container, orchestration and staging for the womblex engine.
2. **Initialising `services/womblex` for the first time falsified several
   assumptions those threads were built on** (§3). The submodule had been declared
   in `.gitmodules` since it landed but never initialised, never fetched by CI, and
   never consumed by any build — so the engine's real API surface had never been
   read. Some of what redline built already existed upstream; one binding is
   written against an API that does not exist.

The plan below is the pre-D14 thread list, revised against what the engine
actually provides.

### Decision D14 (new)

**Numbatch and womblex are consumed as git submodules; redline builds on their
shipped capabilities rather than reimplementing them.**

- Mechanism follows runtime: the two **Python** upstreams are submodules; the
  **JavaScript** upstream (Wayfinder) stays a build-time pin, because a submodule
  drags its whole package set into the pnpm workspace (ADR-0012). This is a
  narrower and more honest rule than "one vendoring idiom for both upstreams".
- Ratified as [**ADR-0015**](./adr/0015-upstream-python-engines-are-submodules.adr.md),
  which **supersedes [ADR-0013](./adr/0013-numbatch-fork-is-materialised-from-a-pin.adr.md)**
  in full. ADR-0013 had decided the opposite for Numbatch ("No submodule"), on
  consistency with Wayfinder's pin — and Wayfinder's pin exists for a
  pnpm-workspace reason that does not apply to a Python upstream.
- Before any thread builds something an upstream may already provide, the
  upstream tree is read first (Thread 54).

---

## 2. The thread contract (unchanged)

- One build step including its test. If the exit test needs two unrelated things
  built first, it is two threads.
- One agent, one context. One commit. A PR only on explicit request.
- Tests-first: the test file is written before the implementation file.
- One package where possible.

Numbering continues monotonically so a number never collides with a historical
reference. Threads 37–51 keep the numbers the retired iteration-3 plan gave
them; new work starts at **52**.

---

## 3. What reading the engine changed

Verified against `services/womblex` @ `v0.2.0` (`2c40e65`), readable in-tree for
the first time.

**Already provided upstream — redline should not build these:**

| Capability | Where, upstream | What redline had built |
|---|---|---|
| Engine container image | womblex's own `Dockerfile` (`ENTRYPOINT ["womblex"]`, `[cloud]` extra) | `Dockerfile.womblex` — **retired** |
| Pipeline orchestration over a corpus | `womblex run` / `process_batch` | a 95-line shell entrypoint looping the CLI per file — **retired** |
| S3/MinIO staging | `store/remote.py` (fsspec; `WOMBLEX_S3_ENDPOINT`, MinIO explicitly supported) | a hand-rolled `mc`/`minio` sync in a heredoc — **retired** |
| Batching, retry, horizontal scale-out | `cloud/queue.py` + `cloud/worker.py` (Postgres job queue, `enqueue`, `worker`, `finalize`) | nothing — a gap redline had simply not filled |

**Confirmed accurate** (no change needed): `architecture.md` §7.1 (chunking is
offline — the Kanon-2 tokeniser is free on Hugging Face), §7.5 (the query-embed
path is `analyse.embed.embed_texts` + `cli._shared.make_isaacus_client`).

**Falsified:** `architecture.md` §2/§3 describe womblex's OCR as "PaddleOCR" and
§8 as `rapidocr-onnxruntime`. Both name the same thing — `engine: paddleocr` is
the *config value*, rapidocr the implementation. Imprecise, not contradictory.

**Still redline's own, correctly** — do not dissolve these into the engines: the
domain, the comprehension lens, the control surface, and the nearest-neighbour
matching in `ClassifyByRetrieval`. `womblex/analyse/query.py` is an internal
enrichment-graph loader for PII, explicitly *"not an end-user query API"*; womblex
produces embeddings, redline ranks them.

### What reading Numbatch changed

Verified against `DeepCivic/Numbatch` @ `main`.

**The `kanon-answer-extractor` overlap is not real — the financial extension
stays.** `architecture.md` §7.6 raised the possibility that womblex's
`kanon-answer-extractor` (structured field extraction) could retire redline's
Numbatch financial extension. It cannot: **neither `kanon-answer-extractor` nor
`kanon-universal-classifier` appears anywhere in womblex's source.** They are
named only in its README, in a passage describing what the *Isaacus platform*
offers. womblex does not wire them, so consuming them would mean redline calling
Isaacus directly — which `architecture.md` §1 forbids. Numbatch has no
currency/financial capability of its own either (verified by search across
`backend/`), so Threads 6–8's extension is genuinely additive, exactly as
ADR-0005 intended. **Close §7.6 as resolved: no change.**

**Confirmed, so the design holds:** `MIN_SAMPLES_PER_TOPIC = 10`
(`backend/app/models/profile.py:23`); Numbatch has **no** retrieval, embeddings
or vector store (ADR-0008's premise); and its ingestion already accepts womblex
shards natively — `POST /ingestion/womblex-configs/{id}/upload` takes a
`*.chunks.parquet` straight into the feed's S3 prefix, with an
`s3_womblex_bucket` setting. The seam redline assumed is real and already built.

**Already provided upstream — three Track L threads shrink or change shape:**

| Thread | Upstream capability | Effect |
|---|---|---|
| 44 — corrections push | `POST /profiles/{id}/feedback/single`, `GET /profiles/{id}/feedback/pending`, full-label replacement + scopes + append-only `feedback_corrections` audit (ADR-0020) | Becomes an adapter call over an existing API, not a build |
| 49 — sample accrual | Topic-scoped partial unique indexes — `(topic_id, source_doc_id, chunk_id)` with provenance, `(topic_id, text_hash)` without (ADR-0011, ADR-0016) | Re-push idempotence is upstream's; redline only maps decisions to samples |
| 50 — train/activate | `POST /profiles/{id}/activate-adapter` + replay comparison (ADR-0021) | **Needs redesign — see below** |

**Thread 50 as planned works against upstream.** It reads: *"Crossing
`MIN_SAMPLES_PER_TOPIC` triggers train → activate (upstream ADR-0021); the user
never blocks on it."* ADR-0021 decided the **opposite**, and the ADR cited is the
one that reversed it: Numbatch used to self-activate a succeeded training run and
deliberately stopped, because it was *"a leap of faith… no way to see what a new
adapter version would do to real documents before it went live — or to go back if
it made things worse."* Activation is now *"a user-controlled pointer move"*,
paired with `GET /batch-inference/jobs/{id}/compare/{other_id}` for an on-the-fly
per-document diff between adapter versions, with documents whose corrections
landed between runs flagged `fixed_by_correction`.

Auto-activating would rebuild the behaviour upstream removed, and forfeit the
comparison surface. Thread 50 should instead **surface** the upstream flow:
auto-*train* on crossing the floor (that part is uncontroversial), then present
the replay diff and let the specialist activate. That is also a better fit for
procurement, where an unreviewed classifier change landing mid-evaluation is a
defensibility problem, not just a technical one.

### What the upstream delta changed (2026-07-29)

Upstream `main` is **42 commits** ahead of the pin. Read at `c032cf7`; every
claim below is a diff, a schema comparison or a line of upstream source.

**womblex now ships a money/currency capability.** ~2,244 lines across six new
modules (`process/money.py`, `money_columns.py`, `money_vocab.py`,
`money_stage.py`, `store/money_output.py`, `cli/money.py`), landed `7b767d5`
and refined over six follow-ups. So **V3 (58) and ADR-0016 build something
upstream provides**, contrary to ADR-0015, and all three of ADR-0016's stated
premises are now false:

| ADR-0016 premise | Status at upstream HEAD |
|---|---|
| "`value_type` is a constant `text`" | False — `b24368c` maps the openpyxl cell type through `_value_type_for()` |
| "`number_format` … is unset regardless" | False — `b24368c` reads it per cell (on `sheet_cell` *elements*; `TABLE_CELLS_SCHEMA` still carries neither) |
| "womblex has no currency capability at all" | False — the money op above |

The conclusion is also measurably too narrow. `derive_is_currency` requires an
explicit marker; womblex measures its **column-evidenced** path as carrying
**~98.7%** of amounts, and says of the marker path: *"it has nothing to say
about a bare `50000` in a column."* A tender schedule headed `Unit Price ($)`
with cells `4500`, `12000` flags nothing today and V3's pivots total zero.
`*.money_spans.parquet`'s `table_cell` locus is anchored on
`(source_hash, parent_elem_order, row, col)` — the join key `map_table_cell`
already produces — so this is a read, not an integration, and it carries what a
boolean cannot: exact `decimal128(38,4)` `value`, resolved `currency`,
`multiplier`, `negative`, linked ranges, `confidence`. Its `narrative` locus
additionally reaches prose prices, which redline has no path to at all.

**OCR'd PDFs now emit real table cells.** At the pin a scanned table region
produced `TextBlock(text="[TABLE]")` — zero `table_cells` rows, so scanned
tenders priced at zero by construction and would have read as a corpus problem.
`1f85f7e`/`9dce5b2`/`8d0f20e`/`a4d1f50` added `ingest/table_grid.py` +
`ingest/ocr_tables.py` and wired `reconstruct_table()` into
`strategies_scanned.py:432`. Three gates bound what V5 should expect:
region-based engines only (**paddleocr**; the LLM/VLM engines return markdown
with no regions), refusal on deskew, and refusal below the precision gates
(`None` rather than a mis-binned grid). Deskew is *not* config-exposed and fires
only at `|skew| > 0.5°` with confidence `> 0.3` (`paddle_ocr.py:487`), so it is
a measure-on-the-corpus item, not a tunable.

Knock-on worth having: womblex's `CHUNKING.md` notes a scanned page with a clean
table now contributes a markdown-table chunk *in place of* the narrative run,
"and the narrative block beside it no longer double-counts the table text" — so
this improves **V2's** retrieval quality, not just V3's pricing.

**Unchanged, so most of Track V stands.** `TABLE_CELLS_SCHEMA`,
`ELEMENT_SCHEMA`, `CHUNKS_SCHEMA` and `EMBEDDINGS_SCHEMA` are byte-identical;
`womblex/__init__.py` still exports nothing but `__version__`; the
`analyse.embed.embed_texts` and `cli._shared.make_isaacus_client` signatures V1
uses are stable. **Thread 61's premise re-verified against source** (line numbers
have moved): `form` (`orchestrator.py:280`), `image` (`:288`) and `page_break`
(`:412`) are still constructed with no `text=`, so they still serialise
`text: None` — and the OCR-table change gives scanned pages a *new* way to trip it. The
`content_type` join-key gap (§6.2) is untouched and still V5's.

**Maturity caveat.** The money op landed 2026-07-27 and took six defect-fixing
commits on the 27th–28th, including *"Four money-parsing defects found by
auditing real financial documents"*. There are **no published accuracy figures**
for it (no labelled money ground truth) or for table reconstruction (the report
is wired into the generator at `e8d56fd`; `EXTRACTION.md` has not been
regenerated). The ~98.7% measures *where amounts live*, not extractor recall.
Adopt on the architecture argument, and budget for finding defects on a real
tender corpus — `*.money_columns.parquet` is the surface that makes them
findable.

---

## 4. Track V — the lean vertical (current priority)

**Goal: a real procurement corpus goes in, and the results come out on screen,
delineated by topic and brand.** Nothing else. The comprehension-lens work
(Track L, Threads 42–50) and the trained-classifier overlay are **deferred** —
they are a second-order improvement on a product that does not yet render.

**Numbatch is not on this path.** Classification runs cold-start over womblex
embeddings (ADR-0008's first pass — no samples, no training, no adapter), and
pricing comes from womblex's own currency-typed table cells, which already cross
the JSON seam as `ExtractionTableCell.isCurrency`. The Numbatch stack is needed
when a *trained* overlay is wanted, or when the financial extension's
per-(document, requirement) roll-up is wanted in preference to raw cell typing.
Neither is needed to see the grid.

### What already exists (verified, not assumed)

Far more of this slice is built than the thread list implied. All of the
following is green under `./validate.sh`:

- **Use cases** (`redline-application`): `IngestDocuments`,
  `AssignDocumentsToGroups` (**the brand delineation**), `ClassifyByRetrieval`,
  `ClassifyWithHardRules`, `AdjudicateUnclear`, `ClassifyResponseGroup`,
  `ExtractFinancials`, `BuildEvaluationTable`, `BuildDocumentMap`.
- **Adapters**: womblex extraction reader, embedding reader + text embedder,
  Numbatch classifier, Drizzle persistence with migrations.
- **Web core** (`apps/redline-web`, 58 tests): `WorkflowController` + container,
  `ReviewGrid` + view, `PricingPivot` + view, Excel export, workflow manager.
- **Infra**: the `womblex` compose profile (engine's own image + cloud runner),
  `redline-postgres`, MinIO.

So the slice is not a build-out. It is **four fixes and a shell.**

### V1 (56) — Fix the womblex bindings against the real schema

Three defects block the real lane. All share one cause: integration code written
against an assumed schema, with the correction *documented in `architecture.md`
§7 and never applied to the code*. The submodule makes all three checkable.

| Where | Defect | Consequence |
|---|---|---|
| `real_extractor.py:159` | `from womblex import embed_query, embedding_model_id` — neither symbol exists (`womblex/__init__.py` exports nothing) | `ImportError` on construction; **no query embedding, so no retrieval** |
| `shard_reader.py:131` | `_require(row, "elem_order", "element_order")` — womblex's `TABLE_CELLS_SCHEMA` writes `parent_elem_order` | `ShardSchemaError` on **every** real table-cell row |
| `shard_reader.py:135` | `_require(row, "col_index", "column_index", "column")` — the schema column is `col` | `ShardSchemaError` on **every** real table-cell row |
| `shard_reader.py:137` | `is_currency` / `currency` — no such column upstream; the schema is `row`/`col`/`value`/`value_type` | every currency cell arrives `isCurrency=False`; **no pricing anywhere** |
| `tests/test_real_extractor.py:89` | the fixtures write the *invented* schema (`elem_order`, `col_index`, `is_currency`) | the suite stays green while the mapping raises on every real row — this is *why* all four survived |

Fixes: use `womblex.analyse.embed.embed_texts([text], make_isaacus_client(),
model=…, task="retrieval/query")`, drawing the model from womblex's own
`EmbeddingConfig` rather than restating it; accept `parent_elem_order` and `col`;
rebuild the fixtures against womblex's real `TABLE_CELLS_SCHEMA` and pin them to
it. `architecture.md` §7.3–§7.5 are the specification.

**Currency needed respecifying.** The route above — "derive currency from
`value_type` (and `number_format` for `sheet_cell`, which carries it)" — is
falsified by the engine: `value_type` is always `"text"` at `v0.2.0`,
`number_format` belongs to `ELEMENT_SCHEMA` rather than to `table_cells` and is
unset, and womblex has no currency capability at all. Currency is derived from the
verbatim `value` string and **requires an explicit marker — a bare number is not
currency**, because redline cannot tell a price from a quantity and summing them
would make V3's pivots confidently wrong. Settled as
[ADR-0016](./adr/0016-currency-is-derived-from-the-verbatim-cell-value.adr.md).

_Exit: a test maps a real `table_cells` row — real column names, pinned to
`TABLE_CELLS_SCHEMA` — and a marked currency cell flags `isCurrency=true` while
the bare number beside it does not; the query embedder calls womblex's
`embed_texts` with `task="retrieval/query"` and the configured model._

### V1a (61) — Map non-text elements instead of raising on them

**Found by QA on thread 56; it blocks the real lane exactly as V1's four defects
did, and V1 does not fix it.** `map_element` reads `text` with `_require`, but
womblex's `Element.text` is `str | None` and only text-bearing kinds populate it.
`table`, `image`, `figure`, `form`, `page_break`, `sheet_meta` and `sheet_cell` all
serialise `text: None` (`store/output.py:262` writes `e.text` verbatim; the
constructors at `orchestrator.py:263` and `strategies_file.py:90` pass no `text=`
at all). `map_document_extraction` maps every element row, so **one such element
raises `ShardSchemaError` and the entire document's extraction is lost.**

The two are inseparable: `table_cells` rows are only emitted under
`if e.kind == "table"` (`output.py:275`), so every `parent_elem_order` that V1 now
maps correctly points at a `table` element that kills the document first. V1's
currency derivation is therefore unreachable on any real table-bearing shard —
which is the only corpus it exists to serve. V1's exit test does not catch this
because its fixture elements are all text-bearing: the fixtures now use the right
*columns*, but still describe a document shape womblex never produces.

Needs a contract decision, which is why it is its own thread rather than a patch:
`ExtractionElement.text` is non-nullable `string` in `redline-domain`, so the
options are `text: ""`, an `alt_text` fallback for `image`/`figure`, or skipping
non-text kinds entirely — and they serve materially different things to
`BuildDocumentMap`. Recommendation: `alt_text` then `""`, keeping every element so
`elementOrder` provenance stays contiguous.

_Exit: a shard whose elements include `table`, `image` and `page_break` rows maps
to a `DocumentExtraction` with every element present and no raise; the fixture
carries at least one non-text element in every element shard._

### V2 (57) — Retrieval-backed `IProcurementClassifier`

`ClassifyResponseGroup` takes an `IProcurementClassifier`; the container wires
whichever implementation a deployment supplies. Today the only one is Numbatch's,
which needs 10 samples/topic and a trained adapter. ADR-0008 already settled that
**both paths satisfy the same port** — so compose the cold-start path
(hard rules → retrieval → adjudication, all built) behind that port in
`lib/container.ts`, where the app layer may see both application and adapters.

_Exit: `ClassifyResponseGroup` returns `RequirementClassification[]` for a real
group with no Numbatch running and no samples curated._

### V3 (58) — Currency from table cells, no Numbatch

A `IFinancialExtractor` backed by `IProcurementExtractionReader.readTableCells()`
— the currency-typed cells V1 unblocks — mapped to (document, requirement) via
the classification's `sourceChunkId`. Cruder than the Numbatch financial
extension and explicitly a first pass; `architecture.md` §7.4 notes the extension
is the better long-term source. It costs one adapter and removes a whole stack
from the critical path.

_Exit: the review grid shows numeric AUD for a real tender's priced rows; the
per-brand pivot totals them._

> **Respecified 2026-07-29 (§3, upstream delta).** Read `*.money_spans.parquet`
> (`locus='table_cell'`, joined on `(source_hash, parent_elem_order, row, col)`)
> rather than deriving `isCurrency` at the seam. The exit test gains a real
> `Decimal` and an explicit currency, and must cover a **header-evidenced
> bare-number column** — the ~98.7% case redline is blind to today. Supersedes
> [ADR-0016](./adr/0016-currency-is-derived-from-the-verbatim-cell-value.adr.md);
> decide there whether `derive_is_currency` is retained as a fallback for shards
> with no money sidecar. Blocked on 62 (bump) and 63 (run the stage).
>
> **One upstream limitation to carry into the exit test, because no config can
> fix it.** `classify_column` checks vetoes *before* money terms and returns
> early (`money_columns.py:340-344`); the only escape is the header declaring its
> own currency. `rate` is a built-in veto term, and `extra_header_terms` is
> consulted too late to rescue a vetoed column. So `Hourly Rate ($)` classifies
> as money (via `header_currency`) but a bare **`Hourly Rate` / `Day Rate` column
> yields nothing** — a common tender pricing shape. `extra_veto_terms` only adds;
> nothing removes a built-in. If the real corpus hits this, it is an upstream
> change request, not a redline fix.
>
> **The `money:` section in `infra/womblex/redline.yaml` is already written**, and
> its vocabulary was exercised against upstream's real `classify_column`. Every
> term in it is load-bearing — with stock womblex vocabulary, `Subtotal`,
> `Extended`, `RRP`, `Freight` and `Disbursements` columns yield **nothing**
> (header matching is whole-token, so the built-in `total` does not cover
> `subtotal`), while `Cost Centre`, `Payment Terms`, `Value Weighting` and
> `Price Band` are promoted to **money** and would be summed into the pivots as
> prices. The five vetoes exist for that second failure — headers carrying money
> vocabulary that are not money — and each still yields to a header declaring its
> own currency, so `Warranty ($)` survives. Treat the lists as **provisional**
> and tune them against `*.money_columns.parquet` on the first real corpus (60).

### V4 (59) — The Next.js shell

**The only genuinely missing piece.** React/Next matching Wayfinder's `apps/web`
(ADR-0006), serving `/evaluations/:id/grouping`, `/evaluations/:id/review` (incl.
Export to Excel) and `/evaluations/:id/pivots` over the existing
`WorkflowController`. No new logic — the view models, sorting, filtering, deep
links and export are all built and tested; this renders them. Wires the existing
Playwright specs (`apps/redline-web/e2e/`) into CI, closing the `/e2e` deviation
in `CLAUDE.md` and the browser half of Threads 38–40.

_Exit: Playwright green in CI against served routes._

### V5 (60) — Real corpus, end to end

Run a real procurement corpus through: `womblex` profile ingests →
sidecar serves JSON (`WOMBLEX_MODE=real`) → group documents by vendor → classify
by retrieval → render. Needs `ISAACUS_API_KEY` (the embed stage is Isaacus-only;
without it there are no embeddings and no retrieval — `architecture.md` §2) and a
corpus in the git-ignored `services/womblex-ingest/tests/corpus-local/`.

_Exit: a specialist opens the review grid for a real tender and sees each
document delineated by topic and brand, with provenance back to source._

---

## 5. Build state

| # | Thread | Track | Package(s) | Status |
|---|---|---|---|---|
| 37a | womblex pod (test harness) | H | infra | ⛔ **retired** — the engine ships its own image, runner and staging (§3). Replaced by the `womblex` compose profile building `services/womblex` + `scripts/womblex-engine-smoke.sh`. |
| 37b | Real womblex binding | H | womblex-ingest | ↪ **absorbed into V1 (56)** — the schema defects were its real content |
| 56 | V1 — fix the womblex bindings | **V** | womblex-ingest | ✅ **done** — sidecar pytest 118 passed, 1 skipped (the schema drift guard, which needs the `[womblex]` extra). All four defects fixed (the `col` miss was found during review); currency respecified as [ADR-0016](./adr/0016-currency-is-derived-from-the-verbatim-cell-value.adr.md) after `value_type` proved always `"text"`. Fixtures rebuilt on womblex's real `TABLE_CELLS_SCHEMA` and pinned to it by a drift guard; `pyarrow` moved into `[dev]` so the real-shard lane actually runs instead of skipping. |
| 61 | V1a — map non-text elements | **V** | womblex-ingest | 🔵 **next** — found by QA on 56 (§4 V1a). `map_element` requires `text`, but womblex writes `text: None` for every non-text kind; one such element raises and the **whole document's extraction is lost**. Blocks the real lane. |
| 57 | V2 — retrieval-backed classifier | **V** | redline-web | 🔵 next |
| 58 | V3 — currency from table cells | **V** | adapters | 🔵 next — **respecified** (§4 V3): read `*.money_spans.parquet` instead of deriving `isCurrency`. Supersedes ADR-0016. Blocked on 62 + 63. |
| 62 | Bump the womblex submodule to `v0.3.0` | **V** | infra, womblex-ingest | ⚪ **not started** — blocked on upstream cutting the tag (`__version__` is still `0.2.0` after 42 commits, and `validate.sh` #13 needs an exact tag or it degrades to warn+skip, going quiet exactly when drift is largest). Bump the submodule and the sidecar's `womblex==` pin together. Enables 58 and the OCR table cells. |
| 63 | Run the money stage | **V** | infra | ⚪ **not started** — the `money:` section is already in `infra/womblex/redline.yaml` (inert until 62; pydantic ignores unknown sections — verified), so this thread is the *invocation*: a `womblex money --shards` step after the run. Not part of `womblex run`/`worker`, and `money_shards()` takes a local `Path` while the distributed lane publishes to S3 — needs a stage-in/stage-out decision (§4 V3). |
| 59 | V4 — Next.js shell | **V** | redline-web | 🔵 next (was 41) |
| 60 | V5 — real corpus end to end | **V** | infra | 🔵 next — measure the three new OCR-table gates (paddleocr-only, deskew refusal, precision refusal) on the real corpus; still owns the `content_type` join-key gap (§6.2, unchanged upstream) |
| 38 | In-app review grid | P | redline-web | ✅ **verified** — 58/58 green (was recorded as 63/63; `vitest run` reports 58). Currency sorts numerically, source deep-links carry element/chunk — **page is null for real table cells**, which `TABLE_CELLS_SCHEMA` does not carry. Browser leg → 59. |
| 39 | Pricing pivots | P | application, redline-web | ✅ **verified** — pivots match hand-computed totals and the frozen Wayfinder roll-up. |
| 40 | Excel export | P | redline-web | ✅ **verified** — real `Number` cells, blank-not-zero, hyperlink source column; `write-excel-file@4.1.1` wired. "Workbook opens" → 41. |
| 52 | womblex submodule wiring | H | infra, workspace | ✅ **done** (this change) — CI fetches submodules; `validate.sh` #13 guards pin drift; static guards exclude the vendored tree. |
| 53 | Numbatch submodule + superseding ADR | H | infra, docs | ✅ **done** — submodule @ `72bcead`; overlay moved to `services/numbatch-extension/`; [ADR-0015](./adr/0015-upstream-python-engines-are-submodules.adr.md) supersedes ADR-0013; the four dead `infra/docker/*.Dockerfile` compose refs now resolve |
| 54 | Upstream capability audit | H | docs | ✅ **done** (§3) — womblex and Numbatch both read; findings folded in |
| 41 | Next.js shell | H | redline-web | ↪ **renumbered V4 (59)** |
| 42 | Collision selection, ordering & capping | L | domain | ⏸ **deferred** — not on the lean vertical |
| 43 | `BoundaryDecision` entity | L | domain | ⏸ **deferred** — not on the lean vertical |
| 44 | Decision persistence + corrections push | L | adapters | ⏸ **deferred** — shrunk (§3): upstream owns corrections + audit |
| 45 | Lens persistence | L | adapters | ⏸ **deferred** — not on the lean vertical |
| 46 | Lens portability | L | application | ⏸ **deferred** — not on the lean vertical |
| 47 | Lens stage machine | L | redline-web | ⏸ **deferred** — not on the lean vertical |
| 48 | Collision resolution surface | L | redline-web | ⏸ **deferred** — not on the lean vertical |
| 49 | Sample accrual | L | adapters | ⏸ **deferred** — shrunk (§3): upstream dedupe indexes give idempotence |
| 50 | Train/activate policy | L | adapters | ⏸ **deferred** — needs redesign (§3): as written it contradicts upstream ADR-0021 |
| 55 | Retire the air-gap machinery | H | womblex-ingest, redline-web | ✅ **done** — ADR-0008 amended; machinery removed (§6) |
| 51 | Workspace extraction & release prep | H | workspace | ⚪ not started — last by nature |

---

---

## 6. Carried-forward items

1. **Air-gap retirement (Thread 55) — ✅ done.** ADR-0008 now carries its
   2026-07-27 amendment (Isaacus is a hard requirement; air-gap is a non-goal),
   and the machinery is gone: `EnrichmentMode.OFFLINE` and the `enrichmentMode`
   field, `scripts/thread-15-airgap.sh`, `test_airgap_pipeline.py`,
   `test_enrichment_mode.py`, and the `ingest-config` UI core with its Isaacus
   on/off toggle and e2e spec. `/health` now reports `isaacusEnabled` as a
   diagnostic only.
2. **The `content_type` join-key gap** (`architecture.md` §7.3). womblex joins
   vectors to chunks on `(source_hash, chunk_index, content_type)`; redline's
   `chunkId` collapses that to two keys, so narrative and table chunks at the same
   index collide. Unresolved, and it bites on exactly the table-heavy tender
   corpora redline targets. **Owner: V5 (60)**, the real-corpus run — the earlier
   text folded it into Thread 37b, which §5 has since retired into V1, leaving the
   gap with no owner. V1 did not close it: `EMBEDDINGS_SCHEMA` and `CHUNKS_SCHEMA`
   both carry `content_type`, and resolving it means either a `content_type`-aware
   `chunkId` or an ADR-0014 amendment — a change to the seam's identity, not a
   binding fix. The V1 fixtures now write `content_type` so the collision is
   visible in the shard rather than implied.
3. **The skill layer points at deleted paths.** `.claude/CLAUDE.md` and all five
   `.claude/commands/*.md` reference `docs/comprehension-lens-design.md`,
   `docs/procurement-evaluation-plan.md` and `docs/threads/` — none of which
   exist. Every code-writing skill fails at its first instruction. They also
   encode a thread-doc lifecycle that `architecture.md` abolished, so this is a
   rewrite against this document, not a path fix.
4. **Open questions** from `dev-iteration-2.md` §9, still owned here: tenancy
   mapping (#3), primary/secondary semantics (#4 → Thread 43), ambiguity
   thresholds (#5, unmeasured until a real corpus runs).

---

## 7. Sequencing

**Track V runs to completion before anything else starts.**

1. **V1 (56)** — ✅ done. The four schema defects: no query embedding meant no
   retrieval, and the table-cell mapping raised on every real row.
2. **V1a (61)** — the element mapping. V1 left the real lane still unable to read
   a table-bearing document, so this inherits V1's "nothing downstream can be
   trusted until it is green against real shards" and must land before V3 has
   anything to price.
3. **V2 (57)** and **V3 (58)** — independent of each other, both depend on V1.
   V2 unblocks classification without Numbatch; V3 unblocks pricing without
   Numbatch. Either order, or in parallel.

   > **2026-07-29 (§3, upstream delta).** V3 now sits behind **62** (submodule bump) and **63**
   > (run the money stage), and 62 is itself gated on an upstream `v0.3.0` tag. If
   > that tag is slow, run **61, 57 and 59 first** rather than blocking the track
   > — V3 is the only thread that needs the newer engine.
4. **V4 (59)** — the shell. The only piece that is genuinely new code, and the
   only reason the product cannot be looked at today.
5. **V5 (60)** — the real corpus run. The point of the exercise.

Then, and only then:

6. **42–50** — Track L, in dependency order, scoped by §3's findings. Revisit
   *after* V5 has shown what the cold-start path actually gets right on a real
   corpus — that evidence should shape the lens work rather than be assumed.
7. **51** — workspace extraction and release, last by nature.

### What Track V deliberately does not do

- **No trained classifier, no samples, no adapter.** ADR-0008's first pass only.
- **No Numbatch stack.** Not started, not built, not required. It re-enters when
  a trained overlay or the financial extension's roll-up is wanted.
- **No comprehension lens.** Collisions, boundary decisions, lens persistence and
  portability all wait.
- **No workspace extraction.** Ship-shape is a later concern than see-shape.
