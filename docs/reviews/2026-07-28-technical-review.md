# redline — Technical Review (2026-07-28)

> **Status:** point-in-time review record · does not track work. Anything here
> that becomes work belongs in [`delivery-plan.md`](../delivery-plan.md) as a
> thread; anything that changes design belongs in an ADR.
>
> **Context:** requested while womblex currency handling is awaited upstream.
> At `v0.2.0` the engine has no currency capability at all — `value_type` is
> always `"text"`, `number_format` is unset — so redline derives `isCurrency`
> at the seam per [ADR-0016](../adr/0016-currency-is-derived-from-the-verbatim-cell-value.adr.md).
> That interim derivation, and everything that consumes it, got particular
> attention here.

## Scope and method

- Reviewed at `40487fc` (current `main`, also the base of this branch).
- Full `./validate.sh` run on a real Node 22 + pnpm 9.12 host with
  `services/womblex` and `services/numbatch` submodules initialised and
  Wayfinder vendored from `wayfinder.pin`: **13 of 14 checks pass** —
  typecheck, lint, all TS suites, both pytest suites, the purity guards and
  the womblex pin guard (`v0.2.0 == 0.2.0`) are green. The one failure was
  finding F1, fixed in this PR; the gate is green here as of the fix.
  Note the pin guard passes *locally* and skips in CI — see F12.
- All four `@redline/*` packages, `apps/redline-web/src/lib`, and both Python
  services read end to end. Submodules were read as schema references only.
- Currency behaviour was verified **empirically** — every parse/derivation
  claim below was executed against the code on this branch, not inferred.
- CI history for `main` checked via the GitHub API.

## Verdict

The architecture discipline is real, not aspirational: the domain has zero
external imports, the application layer stays inside its two allowed
dependencies, every port returns Results and nothing throws across a package
boundary, adapters are thin HTTP+JSON mappings with injected clients, and the
seam modules (`shard_reader.py`, `records.py`) are exactly as single-purposed
as `architecture.md` claims. Test discipline is equally real — the ADR-0016
marker forms are pinned, the schema mirror is guarded against upstream drift,
and the `write-excel-file` cell shape was genuinely verified against the
bundled types (the v4 `ReturnType.toFile` / multi-sheet `{data, name}` usage
in `excel-export.ts` is correct).

The findings below are therefore mostly edges and seams, with two exceptions:
CI on `main` is currently red (F1), and the one piece of redline code that
*parses* currency amounts gets European-formatted and negative values badly
wrong (F2) — which matters precisely because it is the in-repo reference for
what thread 58 (V3) is about to build.

---

## Findings

### F1 — CI on `main` is red: one unused import fails the new ruff gate (high) — ✅ fixed in this PR

`services/numbatch-extension/financial_extension/src/numbatch_financial/api.py:24`
imported `Awaitable` and never used it (ruff F401). The ruff gate was wired in
`a107769` — the same change that introduced the failure it now reports — and
CI run #48 for merge `40487fc` concluded **failure**, the first red `main`
after 8 consecutive green merges, so every PR based on `main` started red.

The run's log confirms this was the *only* failing check (12 passed, 1 failed,
1 skipped). Fixed here on request: `Awaitable` removed from the import.
`AsyncIterator` and `Callable` are both still used (`api.py:39`, `api.py:51`),
and the extension's 28 tests pass unchanged, so the import was dead rather
than load-bearing.

### F2 — the financial extension mis-parses European-formatted and negative amounts (high)

`services/numbatch-extension/financial_extension/src/numbatch_financial/extractor.py:30`
parses figures by deleting everything outside `[0-9.]` (`_parse_amount`,
lines 47–54). Verified behaviour:

| cell text | parsed | correct |
|---|---|---|
| `$1,234.56` | 1234.56 | ✔ |
| `$1.234,56` | **1.23456** | 1234.56 |
| `$1 234,50` | **123450.0** | 1234.50 |
| `-$500.00` | **500.0** | −500.00 |
| `($1,234.56)` | **1234.56** | −1234.56 |

ADR-0016's Consequences section states the hazard exactly: a *marked*
European-format cell flags `isCurrency=True` at the sidecar, and "parsing
`rawValue` into a number … must not assume Australian grouping without
checking." This code assumes it. The sign losses are worse than the locale
ones — accounting-negative and minus-signed cells are common in pricing
schedules, and a credit summed as a debit is a silently wrong total in
`extract_figure`'s bundle sum (line 80).

The extension is off the Track V critical path (Numbatch is deferred), which
caps today's impact — but it is redline's own code, its tests are green, and
it is the obvious thing for thread 58 (V3) to copy when it builds the
`rawValue → number` parse for the pivots. Recommendation: one shared,
sign-preserving, separator-disambiguating parse (refusing genuinely ambiguous
digit groupings rather than guessing), built in V3 and back-ported into the
extension — not two independent parsers.

### F3 — trailing currency *symbols* are not recognised; trailing codes are (medium)

ADR-0016 specifies a marker "at either end". `_without_currency_marker`
(`services/womblex-ingest/src/womblex_ingest/shard_reader.py:156-172`) honours
that for ISO codes but not for symbols: the symbol branch requires everything
before the symbol to be a ≤2-letter alpha prefix, so a symbol after the digits
never matches. Verified:

- `5 USD` → True, but `1234€` → **False**, `1.234,56 €` → **False**,
  `80 000 $` → **False**
- leading forms all behave: `€ 1.234,56` → True, `-$500.00` → True

The pinned test suite (`tests/test_shard_reader.py:111-133`) has no
trailing-symbol case, which is why the asymmetry is invisible. For a purely
Australian corpus (D1) the practical impact is small — `1234$` is rare in AU
tenders — but the code diverges from the ADR's stated rule, and `€`-suffixed
cells are the *normal* form for any European vendor's schedule. Either accept
a trailing symbol (symmetric with codes) and pin it, or amend ADR-0016 to say
"symbol leading, code either end" deliberately. The current state is neither.

### F4 — the stub lane contradicts ADR-0016: a bare number is currency there (medium)

The stub extractor emits `rawValue="80000", isCurrency=True`
(`services/womblex-ingest/src/womblex_ingest/extraction.py:170-180`), and the
same cell is pinned in the sidecar's API fixtures
(`tests/conftest.py:105-106`, asserted in `test_stub_extractor.py:62` and
`test_ingest_api.py:163`) and in the TS adapter's contract fixture
(`packages/redline-adapters/src/womblex/__fixtures__/extraction-tender.pdf.json:31-32`).

`"80000"` is ADR-0016's *canonical negative example* — the exact value the
ADR (line 65) and the real mapping's tests (`test_shard_reader.py:142`) pin
as `isCurrency=False`. So the stub lane and the real lane now assert opposite
truths about the same cell, and the TS adapter contract is green against a
shape the real lane can never produce. Anyone building V3 against the stub
inherits the permissive assumption the ADR exists to forbid. Fix is cheap:
give the stub cell a marked value (`"$80,000.00"`) so both lanes obey the
derivation — the stub's job is to model the seam's *shape*, and the shape now
includes ADR-0016's semantics.

### F5 — `saveResponses` is upsert-only, so a rebuild leaves stale rows (medium)

`DrizzleEvaluationRepository.saveResponses`
(`packages/redline-adapters/src/persistence/drizzle-evaluation-repository.ts:169-187`)
upserts each row keyed on `(group, requirement, document)`. The class header
says upserts exist precisely "so a use-case can re-run a stage" — but a re-run
of `BuildEvaluationTable` whose classifier now matches a document to a
*different* requirement inserts the new row and leaves the old one in place:
nothing deletes rows for the evaluation that the rebuild no longer produced.
The review grid and pivots then show both the old and new classification, and
the pivot totals double-count the document. The rows are also written in a
per-row loop with no transaction, so a mid-loop failure persists a partial
table while returning an error.

Recommendation: make the rebuild replace-by-evaluation (delete
`where evaluationId = …` then insert, in one transaction), which also fixes
the partial-write case.

### F6 — one bad document fails the whole evaluation's ingest run (medium; sharpens two tracked items)

Two known defects are tracked as *per-document* losses; the blast radius is
actually the run. `RealWomblexExtractor.extract`
(`services/womblex-ingest/src/womblex_ingest/real_extractor.py:101-106`) maps
every document in the prefix inside one call, and `POST /ingest` wraps the
whole call in one try/except → 502. So:

- **Thread 61** (`map_element` requires `text`, womblex writes `text: None`
  for every non-text kind — `shard_reader.py:194`): one `table` element in
  one document raises `ShardSchemaError` and **the entire evaluation's ingest
  fails**, not "the whole document's extraction is lost" as §4 V1a currently
  puts it. Since every real tender has tables, the real lane cannot ingest
  *anything* until 61 lands — consistent with 61's "blocks the real lane"
  status, but the plan understates it.
- **The `content_type` join-key gap** (carried item #2): a document carrying a
  narrative and a table chunk at the same `chunk_index` produces two vectors
  with the same recomposed `chunkId`, and `make_document_embeddings` refuses
  duplicates (`records.py:163-165`) — a `ValueError` that likewise 502s the
  whole run. Loud rather than silent (good), but "V5 will measure it" is
  optimistic: V5's first real table-heavy corpus may refuse to ingest at all.
  Worth deciding the `chunkId` shape *before* the V5 run, not during it.

No new code defect here beyond what 61 and carried item #2 already track —
the finding is that both should be re-stated with run-level consequence, and
that per-document isolation in `extract()` (map what maps, report what
raised) would turn both from run-killers into visible per-document gaps,
which is the failure mode ADR-0016 already argues for.

### F7 — two sidecar routes break the Result-shaped error contract (low)

`main.py`'s module docstring promises errors cross as
`{"error": {code, message}}`. Two paths don't:

- `POST /embeddings/query` (`main.py:174-186`) calls `embedder.embed()` bare.
  On the real lane that is an Isaacus network call — the *expected* failure
  mode (key missing, quota, outage) surfaces as an unhandled 500 with a stack
  trace, not a Result body. The extraction route wraps its seam call; this one
  should too.
- `POST /ingest` marks the run failed only around `extractor.extract`
  (`main.py:107-111`). A `storage.put_object` failure in the write loops
  (lines 113–137) raises out of the handler: 500, no Result body, and the run
  is left `"running"` forever in the registry.

### F8 — fabricated provenance: absent `elementOrder` becomes element 0 (low)

`build-evaluation-table.ts:172` (`costing?.elementOrder ?? 0`) and
`numbatch-financial-extractor.ts:119` (`sourceElemOrder ?? 0`) both coerce
"no element known" to element 0. The review grid's deep link then points at
the document's first element as though it were evidence. The rest of the seam
is scrupulously null-honest (`page: null`, `chunkId: null`, blank-not-zero in
the export); `source.elementOrder` should be `number | null` with the same
honesty, especially given provenance-back-to-source is the product's pitch.

### F9 — duplicate LLM summarisation per document (low)

`BuildEvaluationTable.buildResponse` (`build-evaluation-table.ts:149-157`)
re-reads every chunk of the document and calls `languageModel.summarise` once
per *classification row*. A document matched to N requirements pays N
identical summarise calls over identical passages — pure cost, no behaviour
difference. Cache the summary per `(evaluationId, documentId)` within one
`execute`.

### F10 — delivery-plan carried item 3 is stale: the skill layer was fixed (info)

§6.3 says `.claude/CLAUDE.md` and all five command files "reference
`docs/comprehension-lens-design.md`, `docs/procurement-evaluation-plan.md` and
`docs/threads/` — none of which exist. Every code-writing skill fails at its
first instruction." Verified false as of PR #22's rewrite: the only remaining
mentions of those paths are deliberate "`docs/threads/` was deleted and is not
to be recreated" notices. The item should be closed so the plan's §6 stays
trustworthy.

### F11 — smaller notes (info)

- **`id` columns are `text`, CLAUDE.md says uuid.** Every `redline_` table
  uses `text("id")` (`schema.ts`), while the architecture rules say "every
  table has `id` (uuid)". Response ids are deliberately composite strings
  (`group:requirement:document`), so either the rule or the schema should
  yield — the mismatch is the defect, not either choice.
- **No secondary indexes.** All list reads filter on `evaluation_id`
  (`drizzle-evaluation-repository.ts`); the migration creates FKs but no
  indexes on them. Fine at demo scale; add before the real corpus (V5).
- **`row.stage as IntakeStage`** (`row-mapping.ts:35`) trusts the column
  blindly; a bad row round-trips into the domain unvalidated. A cheap
  membership check would keep the "domain owns validation" story true on the
  read side too.
- **NaN-silent dot product.** `classify-by-retrieval.ts:60-64` iterates the
  chunk vector's length; a query vector of a different dimensionality (same
  declared model) yields `NaN` confidence rows rather than a refusal.
  ADR-0014's model check makes this unlikely; a length guard would make it
  impossible.
- **Sync `POST /ingest` returns 202 with a terminal status** (`main.py:140`).
  Harmless today (the registry docstring owns this), but 200 would describe
  the actual behaviour; 202 implies an async run that never exists.

### F12 — the womblex pin-drift guard never runs in CI, which is where it was meant to bite (medium)

Found while reading run #48's log to confirm F1's cause. `validate.sh` check
#13 compares the `services/womblex` submodule's tag against the sidecar's
`womblex==` pin, and its comment states the intent plainly: it "SKIPs (never
fails) on a clone without the submodule initialised … **CI checks out
submodules, so CI is where this actually bites**."

It does not bite. Run #48 reports:

```
WARN — womblex submodule is not on an exact tag — cannot compare against the 0.2.0 pin
SKIP — womblex pin — submodule not on a tagged commit
```

`actions/checkout@v5` with `submodules: true` fetches the submodule at its
pinned **SHA** without tags, so `git describe --tags --exact-match` finds
nothing and the check skips — silently, because a skip is non-blocking by
design. The guard therefore runs *only* on a local clone that happened to
fetch tags (which is why it passed in this review's local run), and never in
the one place the comment nominates. The drift it exists to catch — the engine
the Parquet mapping is written against diverging from the engine the query
embedder runs — would ship green.

Fix is small: fetch tags for the submodule in CI (a `git -C services/womblex
fetch --tags --depth=1` step, or `fetch-depth: 0` on the checkout), and
consider making the check *fail* rather than skip when `REQUIRE_WAYFINDER`-style
CI strictness is set, so a future regression is loud. Worth doing before V5
(thread 60), since that run is the first to depend on engine/sidecar agreement
against a real corpus.

## What is in notably good shape

Recorded so the review is calibrated, not just critical: the ADR-0016
derivation itself (marker-required, bounded two-marker strip, non-`float()`
number test) matches its ADR everywhere tested except F3's trailing-symbol
edge; validate.sh is honest about what it did and didn't prove (the runner
report and the `WS_SKIPPED` exit-2 path are exactly right — F12 is a gap in
where one guard *runs*, not in how it reports); the embeddings seam
enforces model declaration and L2-normalisation at construction; the
review-grid/pivot/export trio is genuinely pure and its blank-not-zero
posture is consistent across display, sort and export; and the lockfile
guard (#12) closes a subtle vendored-workspace trap most repos would only
discover in CI.

## Recommended order

1. **F1** — ✅ done in this PR; unblocks every future PR's CI signal.
2. **F12** — restore the pin guard in CI while CI is being thought about;
   a green check that never runs is worse than no check.
3. **F5, F7** — small, self-contained correctness fixes; each is a
   `/bugfix`-sized thread.
3. **F4** — cheap fixture fix; do before thread 58 starts so V3 is built
   against ADR-0016-true stubs.
4. **F6** — fold the run-level consequence into thread 61's and carried item
   #2's wording; decide the `chunkId` shape before V5.
5. **F2 + F3** — resolve together as the currency-parse thread that V3
   (thread 58) needs anyway: one shared parse, sign-preserving,
   locale-explicit, with the trailing-symbol question settled in ADR-0016.
6. **F8–F11** — batch into the next pass through their respective packages.
