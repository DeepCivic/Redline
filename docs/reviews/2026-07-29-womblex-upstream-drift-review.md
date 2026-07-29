# redline — womblex upstream drift review (2026-07-29)

> **Status:** point-in-time review record · does not track work. Anything here
> that becomes work belongs in [`delivery-plan.md`](../delivery-plan.md) as a
> thread; anything that changes design belongs in an ADR.
>
> **Trigger:** `services/womblex` is pinned at `v0.2.0` (`2c40e65`, 2026-07-23).
> Upstream `main` is **42 commits ahead**. This review reads that delta against
> the Track V plan and reports what it changes.

## Scope and method

- Upstream read at `c032cf7`; pin read at `2c40e65`. Every claim below is a
  diff, a schema read, or a line of upstream source — nothing is inferred from
  the changelog alone.
- Redline read at `102c450` (current `main`). No code changed by this review.
- Schemas were compared column-by-column (`store/output.py`), not summarised.

## Verdict

**The plan's structure survives; two of its factual premises do not.**

Track V's sequencing, its refusal to pull in Numbatch, and its four-fixes-and-a-shell
framing are all still right. Threads 56 (V1), 61 (V1a), 57 (V2) and 59 (V4) are
unaffected — the schemas they were written against are byte-identical at HEAD.

But **V3 (58) and [ADR-0016](../adr/0016-currency-is-derived-from-the-verbatim-cell-value.adr.md)
are now building something upstream ships**, and they are built on premises the
engine has since falsified. That is the one finding that changes work rather than
wording, and under [ADR-0015](../adr/0015-upstream-python-engines-are-submodules.adr.md)
("build on their shipped capabilities rather than reimplementing them") it is not
a close call.

A second finding — OCR'd PDFs now emit real table cells where the pin emitted a
placeholder — silently unblocks a corpus class V3 and V5 would otherwise have
found empty.

---

## D1 — womblex now has a currency capability. ADR-0016's central premise is false.

ADR-0016 (Status: **Proposed**, so nothing is being unwound) states:

> **womblex has no currency capability at all.** `grep -riE "currency|AUD|money"`
> across `src/` returns nothing.

That was true at `2c40e65`. At HEAD, upstream ships a **money annotation op** —
~2,244 lines across six new modules, landed in `7b767d5` and refined over six
follow-up commits:

| Module | Lines | Does |
|---|---|---|
| `process/money.py` | 697 | Self-evidencing recognition: symbol / ISO 4217 / currency-word prefixes and suffixes, magnitude expansion, ranges, qualifiers, gated accounting negatives, Australian false-positive blocking, exact `Decimal` values |
| `process/money_columns.py` | 410 | Column-evidenced: `classify_column` (number format → header vocabulary + numeric fraction; whole-word vetoes; null markers excluded) and per-cell parsing |
| `process/money_vocab.py` | 358 | Currency tiers, full ISO 4217, symbols, scale table, false-positive regexes, header money/veto terms |
| `process/money_stage.py` | 474 | `money_shards()` over a shard dir; three loci; per-stage checkpointing |
| `store/money_output.py` | 191 | `*.money_spans.parquet` + `*.money_columns.parquet` schemas + IO |
| `cli/money.py` | 114 | `womblex money --shards` |

### Why this is decisive, not merely overlapping

redline's `derive_is_currency` (`shard_reader.py:109`) requires an explicit
marker — a bare number is deliberately **not** currency, because redline "cannot
tell a price from a quantity and summing them would make V3's pivots confidently
wrong." That reasoning is sound and I would not relax it in isolation.

Upstream measured the consequence. From `services/womblex/docs/money-extraction.md`:

> The column path decides **~98.7%** of the corpus's amounts.

and, of the self-evidencing path:

> it has nothing to say about a bare `50000` in a column.

So the marker requirement is not a conservative subset of the problem — it is
**~1.3% of it**. On a tender schedule whose header reads `Unit Price ($)` and
whose cells read `4500`, `12000`, `860`, redline currently flags nothing and V3's
pivot totals zero. Upstream solves exactly this: the column's header supplies
both the money-ness and the currency, numeric cells never promote a column on
their own, whole-word vetoes suppress false headers (`age` vetoes `Age`,
`Average Cost` survives), and a column with no recoverable header is left
un-extracted rather than guessed.

The `*.money_spans.parquet` `table_cell` locus is anchored on
`(source_hash, parent_elem_order, row, col)` — **the exact join key
`map_table_cell` already produces**. This is a read, not an integration.

It also carries what redline's boolean cannot: `value` as exact
`decimal128(38,4)`, `currency` + `currency_source`, `multiplier`, `negative`,
`confidence`, `evidence`, and range linkage. V3's exit test asks for "numeric
AUD"; today redline gets a boolean and re-parses the string itself.

There is a further prize. The `narrative` locus carries `start_char`/`end_char`
in the same coordinate space as enrichment mentions and chunks — so prose prices
("a fixed fee of $48,000 per annum") become reachable by the same
(document, requirement) mapping V3 uses for cells. redline has no path to those
at all today.

**Recommendation.** Respecify V3 (58) as *"read `*.money_spans.parquet`"*, not
*"derive currency"*. Supersede ADR-0016 with an ADR recording that the seam
consumes upstream's money op; retain `derive_is_currency` only if a fallback for
money-stage-absent shards is wanted, and say so explicitly.

## D2 — `value_type` is no longer constant, and `number_format` is now populated

ADR-0016's other two premises, both falsified by `b24368c`
("Preserve number_format and numeric value_type in spreadsheet extraction"):

- `value_type` is no longer always `"text"`. `spreadsheet.py` now maps the
  openpyxl cell type through `_value_type_for()`.
- `number_format` is no longer unset. It is read from openpyxl per cell.

**Nuance that matters, and that partly rescues the ADR's conclusion.** Both land
on `Element` (`ELEMENT_SCHEMA`), i.e. on `sheet_cell` elements from XLSX sources.
`TABLE_CELLS_SCHEMA` is unchanged and still carries neither — `Cell` has no
`number_format` field at all. So:

- For **XLSX** tenders, redline's existing `number_format` branch in
  `derive_is_currency` now actually fires, where before it was dead code.
- For **PDF** tenders — the corpus redline targets — table cells still carry only
  the verbatim string, and D1's column path remains the only route to the ~98.7%.

This does not change the recommendation; it explains why the ADR's *conclusion*
(derive from the value string) was reasonable for PDFs while its *premises* were
stale.

## D3 — OCR'd PDFs now produce real table cells

At the pin, a scanned page's table region produced a placeholder:

```python
blocks.append(TextBlock(text="[TABLE]", ...))
```

— a text block, no `TableData`, therefore **zero `table_cells` rows**. Any
scanned tender ran V3's pricing path against an empty sidecar and would have
looked like a corpus problem rather than an engine limitation.

Five commits (`1f85f7e`, `9dce5b2`, `8d0f20e`, `a4d1f50`, `a4efe50`) added
`ingest/table_grid.py` (245 lines, shared grid geometry) and
`ingest/ocr_tables.py` (202 lines, the OCR feeder), and wired
`reconstruct_table()` into `strategies_scanned.py:432`. Scanned table regions now
reconstruct into real `TableData` → `table` elements → `table_cells` rows.

Three gates are worth recording because they bound what V5 should expect:

1. **Region-based engines only.** `strategies_scanned.py:371` — only `paddleocr`
   supplies OCR regions; the LLM/VLM engines (`mistral-ocr`, `ollama`) return
   markdown with no regions and are excluded. `infra/womblex/redline.yaml`
   already sets `engine: paddleocr`, so redline is on the right side of this by
   accident rather than by decision. **Worth making it a decision** — add a
   comment, because switching engines would silently delete table pricing.
2. **Refuses on deskew.** A deskewed page drops its cell regions
   (`strategies_scanned.py`, "Mapping the layout rect into deskewed space is
   deferred"). Skewed scans still yield no cells.
3. **Refuses below precision gates.** `reconstruct_table` returns `None` rather
   than a mis-binned grid; the placeholder block is kept so the page stays
   visible. Precision-first, matching redline's own posture.

**Recommendation.** No thread of its own, but V5 (60) should state which of these
three the real corpus actually hits, and `redline.yaml` should carry a comment
pinning `paddleocr` for the stated reason.

## D4 — the money op is a per-stage command, not part of `womblex run`

`cli/pipeline.py` (the `run` command) has no money reference, and
`operations/` / `batch.py` do not call it. The compose `womblex` service runs
`worker`, i.e. `process_batch` = extract → chunk → embed. So **bumping the
submodule does not, by itself, produce a single money span.**

Consuming D1 requires an added step: `womblex money --shards <dir>` after the
run. Two frictions:

- `money_shards(shard_dir: Path, ...)` takes a **local path**. The distributed
  lane publishes shards to `WOMBLEX_STORE_URI` (S3/MinIO). The op has no
  `RemoteStore` awareness, so it needs either a stage-in/stage-out step
  alongside `finalize`, or a local-lane run.
- It needs a `money:` config section in `infra/womblex/redline.yaml` (defaults
  are sensible for this corpus — `default_currency: AUD`,
  `implicit_context: false`, `international_numbers: false` — so the section can
  be short).

This is genuine integration work and belongs in its own thread rather than being
smuggled into V3.

## D5 — the pin guard blocks the bump until upstream tags a release

`validate.sh` check #13 compares `git describe --tags --exact-match` on the
submodule against the `womblex==X.Y.Z` extra in the sidecar's `pyproject.toml`.
Upstream HEAD is **untagged**, and `__version__` is still `"0.2.0"` despite 42
commits that add a public CLI command and two new parquet schemas. Bumping today
degrades check #13 from `pass` to `warn` + `skip` — it will not fail the build,
which is worse: the guard goes quiet exactly when drift is largest.

**Recommendation.** Ask upstream to cut **`v0.3.0`** (MINOR — purely additive:
new op, new CLI command, new sidecars, no schema removed) and bump `__version__`
with it. Bump the submodule and the sidecar pin together, in one thread, so #13
stays green.

## D6 — what did *not* change (so most of Track V stands)

Verified byte-identical between `2c40e65` and HEAD:

- **`TABLE_CELLS_SCHEMA`** — `(source_hash, parent_elem_order, row, col, value,
  rowspan, colspan, value_type)`. V1's `parent_elem_order` and `col` fixes remain
  correct, and the fixture drift guard still guards the right thing.
- **`ELEMENT_SCHEMA`**, **`CHUNKS_SCHEMA`**, **`EMBEDDINGS_SCHEMA`** — unchanged.
- **`womblex/__init__.py`** still exports nothing but `__version__`, so V1's
  reason for routing through `analyse.embed` holds.
- **`analyse.embed.embed_texts`** and **`cli._shared.make_isaacus_client`** —
  signatures unchanged. The query-embed fix needs no revision.

Also re-verified at HEAD, against source rather than the plan's line numbers
(which have moved):

- **Thread 61 (V1a) is still required and still blocking.** `map_element` still
  does `str(_require(row, "text"))` (`shard_reader.py:194`), and upstream still
  constructs `form` (`orchestrator.py:280`), `image` (`orchestrator.py:288`) and
  `page_break` (`orchestrator.py:412`) elements with **no `text=` argument** —
  `store/output.py` writes `e.text` verbatim, so those rows still serialise
  `text: None`. D3 makes this *more* urgent, not less: OCR'd pages now produce
  `table` elements where they used to produce text blocks, so scanned tenders
  gain a new way to trip it.
- **The `content_type` join-key gap is unchanged.** Both `CHUNKS_SCHEMA` and
  `EMBEDDINGS_SCHEMA` still carry `content_type`; `chunkId` still collapses to
  two keys. Still V5's (60), as §6.2 of the plan says.

---

## Recommended changes to the delivery plan

| # | Thread | Recommendation |
|---|---|---|
| 61 | V1a — map non-text elements | **Unchanged. Still next.** Premise re-verified at upstream HEAD; D3 widens its blast radius. |
| — | **new** — bump the womblex submodule | **Add.** Blocked on an upstream `v0.3.0` tag (D5). Bump submodule + sidecar pin together; keep validate.sh #13 green. Enables D1 and D3. |
| — | **new** — run the money stage | **Add.** `money:` config section + a `womblex money --shards` step in the compose/finalize flow, incl. the local-path/S3 wrinkle (D4). |
| 58 | V3 — currency from table cells | **Respecify.** Read `*.money_spans.parquet` (`locus='table_cell'`, joined on `(source_hash, parent_elem_order, row, col)`) instead of deriving `isCurrency` at the seam. Exit test gains a real `Decimal` and an explicit currency, and should cover a **header-evidenced bare-number column** — the ~98.7% case redline is blind to today. |
| — | ADR-0016 | **Supersede.** All three premises falsified (D1, D2). Replace with an ADR recording that currency comes from upstream's money op, and stating the fallback policy for money-stage-absent shards. |
| 60 | V5 — real corpus | **Amend.** Note D3's three gates (paddleocr-only, deskew refusal, precision gates) as things to measure on the real corpus. |
| 56, 57, 59 | V1, V2, V4 | **Unchanged.** Nothing in the delta touches them (D6). |
| — | `infra/womblex/redline.yaml` | Comment `engine: paddleocr` as **load-bearing for table pricing** (D3), not a default. |

### Suggested sequencing

`61 (V1a)` → `submodule bump` → `money stage` → `58 (V3, respecified)`.
`57 (V2)` and `59 (V4)` stay independent and can run in parallel throughout.

The bump is the enabling step for two findings at once, but it is gated on an
upstream tag — so if that tag is slow, **do 61, 57 and 59 first** rather than
blocking the track on it. Nothing except V3 needs the new engine.

### One thing to decide

D4's local-path constraint is the only place where a reasonable person could
choose differently: run the money stage in the distributed lane (needs a
stage-in/stage-out wrapper next to `finalize`), or run it locally against
downloaded shards (simpler, does not scale). That choice determines the shape of
the new money-stage thread and is a call for the plan owner, not this review.
