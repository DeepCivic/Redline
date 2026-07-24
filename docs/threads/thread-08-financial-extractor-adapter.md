# Thread 8 — `IFinancialExtractor` adapter

**Status:** ✅ Complete · **Date:** 2026-07-29 · **Version intent:** MINOR (pre-1.0; new adapter surface + additive read endpoint)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 2](../procurement-evaluation-plan.md)
· depends on [Thread 2a](./thread-02a-generalise-requirements.md) + [Thread 5](./thread-05-numbatch-integration.md) + [Thread 7](./thread-07-numbatch-financial-extraction-worker.md)
· honours [ADR-0004](../adr/0004-user-defined-requirements-not-fixed-1-6.adr.md) + [ADR-0005](../adr/0005-numbatch-fork-all-but-frontend.adr.md)

## Goal

Implement `IFinancialExtractor` in `redline-adapters`: read the
`financial_extractions` the Thread 7 worker wrote (per document + `requirementId`)
into `ProcurementResponse.costing` (`estimateAud: number | null` + `description`),
with the currency figure exposed as a real numeric value.

**Exit test:** contract test; currency numeric via `typedDisplayCell`.

## What was built

### Read seam (Python overlay) — `services/numbatch/financial_extension/`

Thread 7 *wrote* `financial_extractions`; there was no HTTP way to *read* them.
Added an additive read endpoint so the adapter has a JSON source (the boundary to
Numbatch stays HTTP + JSON — ADR-0005, "design as if C").

| File | Change |
|---|---|
| `src/numbatch_financial/api.py` | New `build_extractions_router` → `GET /financial-extractions/{source_doc_id}` returning `DocumentExtractionsRead`. Mounted alongside the config router in `build_app`. An unknown document is a **200 with an empty list**, not a 404 — "no figures yet" is a valid empty costing set, not a failure. |
| `src/numbatch_financial/schemas.py` | New `FinancialExtractionRead` (from ORM attributes: `topic_id`, `amount`, `currency`, `description`, `source_elem_order`) + `DocumentExtractionsRead` (`source_doc_id` + list). |
| `tests/test_extraction_read_api.py` | 4 tests: read one document's figures, all figures for a document, the description-fallback (null amount), and the empty-not-404 case. |

Reuses the Thread 7 `FinancialExtractionRepository.list_for_doc` — the read
endpoint is a thin HTTP wrapper over it.

### Adapter — `packages/redline-adapters/src/numbatch/`

| File | Contents |
|---|---|
| `numbatch-financial-extractor.ts` | `NumbatchFinancialExtractor implements IFinancialExtractor` over an injected GET-only `HttpClient` (no global fetch). `extractFinancials` reads each document in the group (`GET /financial-extractions/{doc}`), maps each `topic_id` → `requirementId` via a `NumbatchProfileBinding`, and shapes `FinancialExtraction[]` (`estimateAud` = the parsed figure or `null`; `description` always populated; `elementOrder` = `source_elem_order ?? 0`). Topics with no requirement mapping are dropped, not invented. |
| `financial-wire.ts` | The single place the read seam's wire is narrowed from `unknown` (`parseDocumentExtractions`, `parseErrorBody`). Pydantic serialises the `Numeric` `amount` as a **decimal string** (or `null`); this module parses it to a number and fails `EXTRACTION_FAILED` on a malformed one. |
| `__fixtures__/document-extractions.json` | A captured payload from the read endpoint — one numeric figure + one description-fallback row. |
| `numbatch-financial-extractor.test.ts` | 9 contract tests (below). |

Exported from the adapters index as `NumbatchFinancialExtractor` + its `Numbatch*`
types (aliased to avoid clashing with the classifier's / womblex reader's
`HttpClient`).

## Design decisions

- **Currency stays numeric.** The read endpoint carries the figure as a decimal
  string (Pydantic `Numeric`); the wire parses it to a JS number so
  `estimateAud` is a real `number | null`. The exit test then feeds it through
  Wayfinder's `typedDisplayCell("currency", …)` and asserts `{ isNumeric: true }`
  — the property Threads 13–14 rely on for numeric pivots + numeric Excel cells
  (build plan §1, §9).
- **`topic_id → requirementId` via the same binding as Thread 5.** The extractor
  needs only the `topicToRequirement` map (a subset of the classifier's
  `NumbatchProfileBinding`), so it takes a narrowed binding. The translation lives
  only in the adapter (ADR-0005).
- **Drop unmapped topics, don't invent.** Same rule as the classifier — the
  binding is the source of truth for which topics belong to this evaluation.
- **Empty-not-404 for an unclassified document.** A document with no extractions
  yet returns an empty list; the adapter yields `[]` for it rather than an error,
  so a partially-processed group reads cleanly.
- **GET-only `HttpClient`.** The read seam takes no body, so this adapter reuses
  the womblex reader's `(url) => Promise<HttpResponse>` shape rather than the
  classifier's method-aware one.
- **`elementOrder` defaults to `0` for a fallback.** The domain
  `FinancialExtraction.elementOrder` is a non-null `number`; a description-only
  row has no womblex `elem_order`, so it maps to `0` (the estimate is `null`,
  which is the load-bearing signal that it is a fallback).

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman; Python overlay via isolated venv):

```
redline-adapters test → Test Files 3 passed (3) · Tests 26 passed (26)
  src/womblex/womblex-extraction-reader.test.ts    (8)
  src/numbatch/numbatch-classifier.test.ts         (9)
  src/numbatch/numbatch-financial-extractor.test.ts (9)  ← Thread 8

numbatch financial_extension pytest → 28 passed (was 24; +4 read seam)

./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The `numbatch-financial-extractor` suite reads the captured payload
(`__fixtures__/document-extractions.json`) and asserts: `topic_id
"t-data-residency"` → `requirementId "req-data-residency"` with `estimateAud
1500.5` + `elementOrder 7`; the **exit criterion** — `typedDisplayCell("currency",
"1500.5")` → `{ value: 1500.5, isNumeric: true }`; the description-fallback keeps
`estimateAud: null`; multi-document groups concatenate; unmapped topics drop;
empty documents yield `[]`; and the full error taxonomy (transport → INFRA_FAILURE,
non-2xx / malformed amount → EXTRACTION_FAILED).

## Known limitations / follow-ups

1. **No live Numbatch compose-up in this environment** (no GPU; fork not vendored
   on disk — ADR-0005). The exit test is the captured-payload contract test the
   plan specifies, and the read endpoint is proven standalone against SQLite. The
   read router is grafted onto the fork's app (`include_router`) at Thread 16,
   alongside the Thread 6/7 overlay.
2. The `NumbatchProfileBinding` is injected by the caller (produced by
   `bootstrap-profile.py`, Thread 5). Wiring it through a use-case + persistence
   is Threads 9–10 — specifically `ExtractFinancials` in `redline-application`
   composes `NumbatchFinancialExtractor` into a `ProcurementResponse.costing`.
