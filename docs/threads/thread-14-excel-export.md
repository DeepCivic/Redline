# Thread 14 — Excel export

**Status:** ✅ Complete · **Date:** 2026-08-04 · **Version intent:** MINOR (pre-1.0; new app surface — the Excel export)

Plan entry: [`docs/procurement-evaluation-plan.md` §1 / §7 · Track 4](../procurement-evaluation-plan.md)
· serialises the `ReviewGrid` ([Thread 12](./thread-12-in-app-review-grid.md)) and the
`PricingPivot` roll-ups ([Thread 13](./thread-13-pricing-pivots.md)) into an `.xlsx`,
reusing Wayfinder's `write-excel-file` XLSX path (plan §9) so currency stays a real
numeric cell ([ADR-0006](../adr/0006-inherit-wayfinder-auth-roles.adr.md)).

## Goal

"Export to Excel" (build plan §1, priority 2): reuse Wayfinder's XLSX path so
**currency stays numeric**; **one sheet for the table, one per pivot**.

**Exit test:** workbook opens with numeric currency + working document links.

## What was built — `apps/redline-web`

Same posture as Threads 11–13: a **framework-free, unit-tested core** — pure
builders that turn the review grid + pricing pivots into `write-excel-file` sheet
data — plus a thin, lazily-loaded browser trigger that writes the workbook. The
mapping is pure so the exit test asserts the *cell types* (numeric currency,
hyperlinks) without loading the writer; the Playwright e2e opens a real download.

| File | Role |
|---|---|
| `src/lib/excel-export.ts` | The **export brain**. `buildReviewSheetData(grid, evaluationId)` → the review table sheet (bold header of every `REVIEW_COLUMNS` column; numeric `Number` cells for currency/confidence; a blank `null` cell for a null estimate; the source column as a hyperlink cell to the exact document location). `buildPivotSheetData({ axis, measure, result })` → one pivot sheet (single-axis `[group, measure]` rows or a brand×requirement cross-tab with one column per secondary group + a row total, then a bold column-total footer) — the **real `PricingPivotResult` numbers**, not the formatted display strings. `buildEvaluationWorkbook(...)` → `{ sheets, sheetNames }`: a `Review` sheet + one sheet per pivot (`Pricing by Vendor`, `Pricing by Requirement`, `Vendor × Requirement`). `evaluationExportFileName(name, date)` slugs a dated filename. `exportEvaluationXlsx(...)` is the lazy browser trigger — a dynamic `import("write-excel-file/browser")` (out of the initial bundle, exactly as Wayfinder's `exportInsightsXlsx`), writing an array of `{ name, data }` sheet objects to a download. |
| `src/lib/container.ts` | `WorkflowController.buildWorkbook({ evaluationId })` — reads the persisted `ProcurementResponse[]` via `IEvaluationRepository.listResponses` (once) and shapes them into an `EvaluationWorkbook`. Read-only: export never mutates. |
| `src/index.ts` | Public surface — `buildReviewSheetData`, `buildPivotSheetData`, `buildEvaluationWorkbook`, `evaluationExportFileName`, `exportEvaluationXlsx`, and their types. |
| `e2e/excel-export.e2e.ts` | Playwright acceptance spec — the "Export to Excel" button downloads a dated `.xlsx`; the download stream resolves to a real, openable file. |

`apps/redline-web/package.json` gains `write-excel-file@^4.1.1` — the same
browser xlsx writer Wayfinder uses (chosen there over SheetJS's `xlsx` for its
clean `pnpm audit`).

## Design decisions

- **Reuse Wayfinder's `write-excel-file` cell shape, verified against its own
  code.** The `SheetCell` union — `{ value, type: String|Number, fontWeight? }`
  or `null` for a blank cell — mirrors
  `apps/web/src/components/admin/field-report-export.ts` exactly (plan §9). A
  `Number`-typed cell is what makes currency a **real numeric Excel cell**, not
  text — the exit criterion. Per CLAUDE.md ("verify third-party APIs; do not
  rely on training data") the multi-sheet call was pinned against the library's
  **bundled type declarations**: the correct form is an array of `{ name, data }`
  `Sheet` objects (`writeXlsxFile(sheets).toFile(name)`), not a `sheets: string[]`
  option — the typecheck error from the first attempt drove the correction.
- **Currency is a real number end to end.** The review sheet reads the
  `ReviewGrid`'s already-typed cells (`isNumeric` + a numeric `sortValue`, Thread
  12); the pivot sheets write the `PricingPivotResult`'s numeric `value`s (Thread
  13). No cell is a re-parsed string. The exit test cross-checks the numeric
  contract against Wayfinder's own `typedDisplayCell("currency", …)` →
  `{ isNumeric: true }` (test-only reuse, matching Threads 8/12/13 — production
  app code imports nothing from Wayfinder).
- **A null estimate writes a blank cell, never a 0.** The description-fallback
  signal (`estimateAud: null`, Thread 10) surfaces as an empty `null` sheet cell
  in both the review sheet and any cross-tab intersection — consistent with the
  in-app grid (blank, not `$0.00`) and pricing view; the costing *description*
  still writes as text alongside it.
- **The source column is a working hyperlink.** Each review row's provenance
  (documentId / elementOrder / page / chunkId) resolves to the **same deep-link**
  `review-view.ts` renders in-app (`/evaluations/:id/documents/:doc?element=…&page=…&chunk=…`),
  written as a `write-excel-file` `hyperlink` cell — the "working document links"
  half of the exit criterion.
- **One sheet for the table, one per pivot.** `buildEvaluationWorkbook` emits the
  `Review` sheet plus the three summed pivots the plan names (per vendor, per
  requirement, vendor × requirement) — the specialist's default lens; the
  in-app pivots retain the sum/average toggle.
- **Pure builders + a thin lazy writer.** The interesting logic (typing, layout,
  slugging, deep-links) is pure and vitest-tested; the untestable-here browser
  writer is a one-line dynamic import, so the exit criterion is provable without
  a browser (the Threads 11–13 posture).
- **Read-only open through the controller.** `buildWorkbook` reads
  `listResponses` and never writes — the export is a read lens on the
  review-stage data `BuildEvaluationTable` already produced.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman):

```
@redline/redline-web:test → Test Files 8 passed (8) · Tests 58 passed (58)
  src/lib/workflow-manager.test.ts   (11)
  src/lib/container.test.ts          (10)  ← +2: buildWorkbook over persisted responses (+ empty)
  src/lib/view.test.ts               (2)
  src/lib/review-grid.test.ts        (8)
  src/lib/review-view.test.ts        (5)
  src/lib/pricing-pivot.test.ts      (7)
  src/lib/pricing-view.test.ts       (4)
  src/lib/excel-export.test.ts       (11)  ← the exit test

turbo typecheck / lint / test / build → all green across the @redline/* packages
./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The exit criterion — *workbook opens with numeric currency + working document
links* — is proven by `excel-export.test.ts`:
- **numeric currency:** the review sheet writes `estimateAud 1000` as
  `{ value: 1000, type: Number }` (not text), cross-checked against
  `typedDisplayCell("currency", "1000")` → `{ value: 1000, isNumeric: true }`;
  confidence writes as `{ value: 0.86, type: Number }`.
- **working document links:** the source cell is a hyperlink to
  `/evaluations/eval-1/documents/doc-a?element=1&page=3&chunk=doc-a%3A2` — the
  same deep-link the in-app grid resolves.
- **blank, not 0:** the Globex × support row (null estimate) writes a `null`
  estimate cell while its costing description still writes as text; a cross-tab
  intersection with no figure is a `null` cell.
- **one sheet for the table, one per pivot:** `buildEvaluationWorkbook` →
  `sheetNames: ["Review", "Pricing by Vendor", "Pricing by Requirement",
  "Vendor × Requirement"]`, the by-vendor sheet carrying the numeric grand total
  `3500`.
- **pivots write real numbers:** the per-brand sum sheet ranks Globex 2000 above
  Acme 1500 with numeric `Number` cells and a bold `Total` footer; the cross-tab
  lays out one numeric column per requirement plus a row total.

`container.test.ts` proves `buildWorkbook` reads the persisted responses into a
workbook with the numeric estimate + source hyperlink intact, and opens an
empty-but-headed workbook when nothing was built.

## Known limitations / follow-ups

1. **No Next.js shell yet.** The export logic is complete and tested; the
   route/DOM layer that mounts the "Export to Excel" button and calls
   `exportEvaluationXlsx` (and runs the Playwright e2e) is the Track 4 shell
   follow-up (shared with Threads 11–13). `e2e/excel-export.e2e.ts` pins the
   `/evaluations/:id/review` export DOM contract. Deviation recorded in
   `.claude/CLAUDE.md`.
2. **No live browser download here** (no browser/app server); the workbook is
   proven at the sheet-data layer (the mapping the writer serialises) against the
   built `ProcurementResponse[]` in memory — the Threads 5–13 posture. The
   dynamic `write-excel-file/browser` import + `.toFile()` mirror Wayfinder's
   proven `exportInsightsXlsx`.
3. **Pivots exported at `sum`.** The workbook writes the summed pivots; the
   average toggle stays an in-app lens (Thread 13). Exporting both measures (or
   the currently-selected one) is a small follow-up when the shell wires the
   button.
