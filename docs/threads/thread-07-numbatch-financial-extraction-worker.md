# Thread 7 — Numbatch financial extraction worker

**Status:** ✅ Complete · **Date:** 2026-07-28 · **Version intent:** MINOR (pre-1.0; additive Arq worker stage over the Thread 6 schema)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 2](../procurement-evaluation-plan.md)
· depends on [Thread 6](./thread-06-numbatch-financial-schema-and-api.md)
· enacts [ADR-0004](../adr/0004-user-defined-requirements-not-fixed-1-6.adr.md) + [ADR-0005](../adr/0005-numbatch-fork-all-but-frontend.adr.md)

## Goal

Add the financial extension's **Arq worker stage** (build plan §6): for each topic
a document matched, read womblex's currency-typed table cells for that topic's
already-deduped matched chunks, extract a currency-normalised figure (or a
description fallback), and write one `financial_extractions` row keyed on
`(source_doc_id, topic_id)` — **one figure per (document, requirement), no
duplication**. The `financial_extractions` table itself was already created by the
Thread 6 migration; this thread only adds the writer.

**Exit test:** synthetic tender workbook → figures + provenance in DB; unit +
integration tests.

## What was built

Three new modules in the Thread 6 overlay
(`services/numbatch/financial_extension/src/numbatch_financial/`), plus the read
seam and the Arq entrypoint. Same standalone posture as Thread 6 (SQLite + an
in-memory womblex fake; no MinIO, no GPU, no vendored fork — ADR-0005).

| File | Contents |
|---|---|
| `src/numbatch_financial/extractor.py` | The **pure** extraction logic. `MatchedCell` (a womblex table cell: `elem_order`, `raw_value`, `is_currency`) and `extract_figure(profile, matched_cells, fallback_text)` → `ExtractionFigure`. Currency cells are parsed (symbol/grouping-stripped); a *bundle* profile sums them, a *line-item* profile takes the first (lowest `elem_order`) figure; provenance points at the first matched currency cell. No currency cell → a description-only fallback (`amount`/`currency` = `None`). No I/O. |
| `src/numbatch_financial/extraction_repository.py` | `ExtractionFigure` (the extractor's output DTO) + `FinancialExtractionRepository` — the write side. `upsert` enforces the `(source_doc_id, topic_id)` no-duplication invariant **in code** (look up the existing row and update it in place), so a re-run never writes a duplicate nor trips `uq_financial_extractions_doc_topic`. |
| `src/numbatch_financial/womblex_source.py` | `MatchedTopic` (a topic a document matched + its deduped matched chunk ids), the `WomblexSource` **protocol** (a topic's matched currency cells + fallback text), and an in-memory `FakeWomblexSource` so the stage is provable standalone. In the fork this seam resolves through Numbatch's ingestion store and the roll-up's matched chunk ids. |
| `src/numbatch_financial/worker.py` | `extract_financials_for_document(session_factory, womblex_source, source_doc_id, matched_topics)` — the orchestration: load each matched topic's `financial_profile`, pull its matched cells + fallback, run the pure extractor, upsert; one transaction per document. Topics without a live `financial_profile` are **skipped** (a topic is only financially extracted when configured, Thread 6). `financial_extraction_task(ctx, …)` is the Arq entrypoint the fork registers on its worker (Thread 16); `ctx` carries the `session_factory` + `womblex_source`. |
| `tests/test_extractor.py` | 6 unit tests: bundle sum, line-item first figure, no-currency → description fallback, no cells at all → fallback, unparseable cells ignored, description always populated. |
| `tests/test_extraction_repository.py` | 3 tests: figure + provenance round-trip, upsert idempotency per `(source_doc_id, topic_id)` (one row after two writes), null-amount description fallback. |
| `tests/test_worker.py` | 4 tests incl. **the exit test**: a synthetic tender workbook → `financial_extractions` with figures + provenance; description fallback for a no-currency topic; one figure per matched topic with a double-run proving no duplication; unconfigured topics skipped. |

## Design decisions

- **Pure extractor, thin repository, seam for womblex.** The monetary logic
  (`extract_figure`) is I/O-free and unit-tested in isolation; the repository is
  the only place the worker touches the `financial_extractions` ORM; the womblex
  read is a `Protocol` with an in-memory fake. This keeps the worker itself a
  short orchestration and mirrors the hexagonal seams used across redline (the TS
  adapters inject an `HttpClient`; here the Python worker injects a
  `WomblexSource` + `session_factory`).
- **No-duplication enforced by `upsert`, not the caller.** The build-plan §6
  invariant is a schema constraint (`uq_financial_extractions_doc_topic`, Thread
  6) *and* a repository behaviour: `upsert` updates the existing `(source_doc_id,
  topic_id)` row rather than inserting, so re-running the stage (e.g. after a
  re-classification) is safe and the constraint never bites. The double-run test
  proves one row per pair.
- **`amount` OR `description`.** Directly serves the "dollar estimate **or** a
  short description of costs" requirement (build plan §1): a matched, parseable
  currency cell yields a normalised `amount` + `currency` + `elem_order`
  provenance; otherwise `amount`/`currency` are `NULL` and the prose fallback is
  stored. `description` is always populated.
- **Bundle vs line-item honours the profile's `granularity`.** A bundle sums the
  matched currency figures into one total; a line item takes the first figure in
  document order. Both attach provenance to the first matched currency cell —
  the review grid's source deep-link (Thread 12).
- **No `arq` runtime dependency.** `financial_extraction_task` takes a plain
  `ctx` dict, so Arq stays a deployment concern wired in the fork's
  `WorkerSettings` (Thread 16). The overlay stays dependency-light and the whole
  stage is proven standalone.
- **Standalone posture (ADR-0005).** The fork isn't on disk here (no GPU); the
  worker is proven against SQLite + `FakeWomblexSource`. Wiring the real seam
  (Numbatch's ingestion store) and registering the task on the fork's worker is a
  Thread 16 mechanical step, documented in the overlay README.

## Exit-test evidence

Run via `./validate.sh` (check #11) and directly:

```
services/numbatch/financial_extension pytest → 24 passed
  tests/test_config_api.py            (8)  — Thread 6 config API
  tests/test_migration.py             (3)  — Thread 6 migration
  tests/test_extractor.py             (6)  — pure figure extraction
  tests/test_extraction_repository.py (3)  — upsert / no-duplication write side
  tests/test_worker.py                (4)  — synthetic workbook → figures + provenance  ← Thread 7 exit

./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The worker suite feeds a **synthetic tender workbook** (womblex table cells for a
matched `t-support` topic: `$1,200.50` @ `elem_order 7`, `$300.00` @ `elem_order
9`) through `extract_financials_for_document`, then reads back one
`financial_extractions` row: `amount = 1500.50`, `currency = AUD`,
`source_elem_order = 7` — **figures + provenance in DB**. A second run over the
same document leaves exactly one row per matched topic (no duplication); a
topic with no currency cell stores the description fallback with `amount = NULL`.

## Known limitations / follow-ups

1. **No live Numbatch compose-up in this environment** (no GPU; fork not vendored
   on disk — ADR-0005). The exit test runs the worker against SQLite + an
   in-memory `WomblexSource`. Wiring the real seam over Numbatch's ingestion store
   and enqueuing `financial_extraction_task` from the batch-inference roll-up land
   with the vendored fork (Thread 16), documented in the overlay README.
2. **Currency conversion is not FX-aware.** `extract_figure` normalises the
   *label* to the profile's `target_currency` but does not convert across
   currencies; the build plan's normalisation is a per-topic target-currency
   declaration, not an FX table. Multi-currency conversion, if ever needed, is a
   later enhancement.
3. **Read side is Thread 8.** These rows are consumed by the `IFinancialExtractor`
   adapter (`redline-adapters`) into `ProcurementResponse.costing`.
