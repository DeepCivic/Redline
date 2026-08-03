# ADR-0016 — Currency is derived from the verbatim cell value, not from womblex's `value_type`

- **Superseded** by womblex v0.3.0's `money` op, materialised into
  `redline_money_spans` under
  [ADR-0017](./0017-bulk-womblex-data-stays-parquet-json-is-for-presentation.adr.md).
  Its premises were falsified upstream 2026-07-29 (note below).
  **`derive_is_currency` survives as the documented fallback** — see *What
  survives*.
- **Date**: 2026-07-27

> **2026-07-29.** All three premises below are false against `services/womblex`
> upstream `main` (42 commits past the `v0.2.0` pin this ADR was written from):
> `value_type` is no longer constant and `number_format` is no longer unset
> (`b24368c`), and womblex now ships a full money/currency op — `process/money.py`,
> `money_columns.py`, `money_vocab.py`, `money_stage.py` (`7b767d5` and follow-ups).
> The *conclusion* (require an explicit marker) is also now measurably too narrow:
> womblex measures its column-evidenced path as carrying ~98.7% of amounts, which
> a marker requirement cannot see. See
> [`../delivery-plan.md`](../delivery-plan.md) §3 (upstream delta) and §4 V3. Nothing is unwound
> here — this ADR was never accepted — but it should be superseded rather than
> promoted, and the superseding ADR should state whether `derive_is_currency`
> survives as a fallback for shards written without the money stage.
>
> **Resolved 2026-08-03 — what survives.** The supersession is womblex v0.3.0's
> `money` op, whose column-evidenced path recovers ~98.7% of amounts as exact
> `Decimal` values with a resolved currency, materialised into
> `redline_money_spans` (ADR-0017) and read by `MoneySpanFinancialExtractor`. That
> is the live pricing leg. Answering the question this note left open:
> **`derive_is_currency` survives as the fallback** for shards produced without a
> money sidecar, which is why `shard_reader.py` still implements and cites it
> (`:104`, `:122`, `:208`, `:243`) — those citations are current, not stale. The
> ADR's *reasoning* about `value_type` is history; its *rule* is live fallback code.
> See [`architecture.md`](../architecture.md) §7.4, which owns this now.
- **Corrects**: [`architecture.md`](../architecture.md) §7.4 as it read on
  2026-07-27 ("currency inferred from `value_type`"), which was written before
  `services/womblex` was initialised and is falsified by the engine's source; see
  Context. **That correction has since been applied** — §7.4 now records the
  verbatim-value derivation *and* its supersession by the money op, so it no longer
  says the opposite of this ADR.

## Context

`TableCellRecord.isCurrency` is the only currency signal on the extraction seam,
and Track V's V3 builds the whole pricing path on it: no Numbatch, no
financial extension, just womblex's own table cells. `delivery-plan.md` §4 V1
therefore specifies the fix as *"derive currency from `value_type` (and
`number_format` for `sheet_cell`, which carries it)"*, citing `architecture.md`
§7.4 as the specification.

Reading `services/womblex` @ `v0.2.0` (`2c40e65`) falsifies both halves.

**`value_type` is a constant.** `src/womblex/ingest/spreadsheet.py:13` states it
outright:

> `value_type` is a hint (currently always "text"); formula and number_format
> remain unset — preserving those needs an openpyxl-based reader and is out of
> scope for this refactor.

The literal `"text"` is the only value ever assigned to it in the engine's source
(`spreadsheet.py:325`, `spreadsheet.py:339`), and `Element.value_type` defaults to
`"text"` (`ingest/elements.py:79`). Deriving currency from it yields `False` for
every cell — precisely the defect V1 exists to fix.

**`number_format` is on the wrong shard, and is unset.** It is a column of
`ELEMENT_SCHEMA` (`store/output.py:59-80`), carried on `sheet_cell` *elements* —
not of `TABLE_CELLS_SCHEMA` (`store/output.py:82-91`), whose full column set is
`source_hash`, `parent_elem_order`, `row`, `col`, `value`, `rowspan`, `colspan`,
`value_type`. And the spreadsheet reader leaves it unset regardless, per the same
docstring.

**womblex has no currency capability at all.** `grep -riE "currency|AUD|money"`
across `src/` returns nothing. This is not an oversight in our reading: womblex's
contract is *verbatim extraction* — `pandas` reads with `dtype=str` so `"1,234"`
stays `"1,234"`. Typing the cell is downstream's job by design.

So currency has to be derived by redline, from the one thing womblex does
guarantee: the verbatim `value` string. The remaining question is what evidence is
sufficient to call a cell currency, and that is what this ADR settles — because
the answer determines whether a tender's totals are trustworthy, and getting it
wrong in the permissive direction silently invents prices.

## Decision

**`isCurrency` is derived at the seam from the verbatim cell text, and requires an
explicit currency marker. A bare number is not currency.**

A cell is currency when, after trimming, it carries a currency marker — a symbol
(`$`, `€`, `£`, `¥`, optionally with a ≤2-letter locale prefix such as `A$`,
`AU$`, `US$`, `NZ$`) or an ISO code (`AUD`, `USD`, `EUR`, `GBP`, `NZD`, `SGD`,
`CAD`, `JPY`) at either end — **and** the entire remainder parses as a plain
number. Accounting parentheses (`($1,234.56)`) are unwrapped first. At most **two**
markers are stripped, so `AUD $1,234.56` maps while `AUD price` does not.

Three things this pins:

- **A bare number is not currency.** `"80000"` maps to `isCurrency=False`. redline
  cannot tell a price from a quantity, a page count, or a weighting without a
  marker, and a tender's response tables are full of all four. The permissive rule
  — treat any parseable number in a table as money — would make V3's per-brand
  pivot totals a sum of unrelated columns while looking entirely plausible. A
  missing price is a visible gap a specialist can chase; an invented one is a
  defensibility problem, which is the same reasoning that moved thread 50 away
  from auto-activation.

- **The remainder must be *entirely* numeric.** `"Price (AUD)"` is a header, not a
  cell value; `"12 AUD each"` is prose. Requiring the marker and the number to
  account for the whole cell keeps both out without a second heuristic.

- **`value_type` and `number_format` are honoured when present, and are not
  relied upon.** Both columns exist in womblex's schemas; both are unpopulated at
  `v0.2.0`. The mapping reads them first and falls through to the text scan, so a
  future openpyxl-based reader upgrades the signal without a redline change, and
  the pin in `validate.sh` #13 is what keeps that promise honest.

**Currency *code* stays out of scope.** `TableCellRecord` carries no currency
field and this ADR does not add one: `FinancialExtraction.estimateAud` already
hard-codes the denomination, so a code on the cell would have nowhere to go. The
detection above deliberately accepts non-AUD markers — a `US$` cell is currency —
which means a mixed-denomination tender would total unlike figures. That is a real
limitation, recorded under Consequences rather than papered over.

## Consequences

**Positive**

- V1's exit test becomes provable on plain row dicts, with no womblex install, no
  pyarrow and no Isaacus key — the mapping is a pure function of the cell text.
- V3 gets a currency signal that is true of real shards rather than of
  an assumed schema, which is the precondition for its pivots meaning anything.
- The failure mode is a visible gap, not a silent wrong number.

**Negative**

- **Bare-number price columns are missed.** A table whose header reads
  `Total (excl. GST)` over unmarked numbers yields no currency cells at all. This
  is the main cost of the conservative rule and it will show up on real tenders.
  Fixing it properly means reading the cell's *header* — `ELEMENT_SCHEMA` carries
  `header_rows`, so the data is there — and that is a header-aware derivation
  thread, not a widening of V1.
- **Mixed-denomination tenders total unlike figures.** See the scope note above.
  Carrying a currency code needs a field on `TableCellRecord`, a matching field on
  `FinancialExtraction` (replacing `estimateAud`), and a decision about what the
  pivots do with two denominations — a thread of its own.
- **Locale ambiguity is unhandled, and the hazard lands on the consumer.** The
  numeric test strips `,` and spaces as thousands separators, so a *marked*
  European-format cell flags correctly as currency — `"$1.234,56"` and
  `"$1 234,50"` are both `True` — but its digits are ambiguous. A consumer that
  strips separators the same way reads `1.23456` and `1 23450` for two values that
  are both 1234.56 and 1234.50. `isCurrency` is only a flag; **parsing `rawValue`
  into a number is V3's job, and it must not assume Australian
  grouping without checking.** Unmarked European values are `False` like any other
  bare number. Acceptable for Australian procurement (D1); a correctness bug the
  moment the corpus is not.
- **The marker list is a fixed set.** A currency outside it reads as prose. Additive
  to extend; deliberately not open-ended, because a permissive matcher is how the
  bare-number failure gets back in.

**Re-entry condition.** Revisit when a real corpus has run (V5, thread 60) and the
miss rate on genuinely-priced rows is measurable. Header-aware derivation is the
first thing to reach for, and it is additive on this same seam — `isCurrency` stays
a derived boolean either way.

## Alternatives considered

- **Trust `value_type`, as `architecture.md` §7.4 specifies.** Rejected on the
  engine's source: it is always `"text"`. This is the option the plan assumed was
  available, and recording *why* it is not is most of this ADR's purpose.

- **Treat any parseable number in a table cell as currency.** Rejected. It would
  satisfy V1's exit test and make V3's grid look populated, while summing
  quantities and weightings into price totals. The one thing worse than an empty
  pricing pivot is a confidently wrong one.

- **Patch womblex to emit a real `value_type`.** Rejected under ADR-0015: the
  submodule holds upstream source only, and redline does not modify it. If the
  engine should type its cells, that is an upstream contribution with its own
  release, not a redline-side edit — and redline would still need this derivation
  for every shard produced by an engine older than that release.

- **Defer currency to the Numbatch financial extension.** This is what
  `architecture.md` §7.4 recommends as the better long-term source, and Track V
  explicitly defers it: the extension needs the whole Numbatch stack, which V3
  exists to stay off. The two are complements — the extension is the better source
  when it is running, and this is what the lean vertical uses when it is not.

## Enforcement

- `shard_reader.py` owns the derivation, beside the rest of womblex's schema
  vocabulary; nothing downstream re-derives it.
- `tests/test_shard_reader.py` pins the marker forms, the bare-number refusal, the
  header/prose refusals, and the `value_type`/`number_format` fall-through — on
  plain row dicts, so it runs in the default validate lane.
- `tests/test_real_extractor.py` mirrors `TABLE_CELLS_SCHEMA` exactly and asserts
  that mirror against the engine's real schema object whenever `womblex` is
  importable, so redline's assumed schema cannot drift from upstream's silently.
