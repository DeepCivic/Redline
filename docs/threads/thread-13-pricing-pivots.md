# Thread 13 — Pricing pivots

**Status:** ✅ Complete · **Date:** 2026-08-03 · **Version intent:** MINOR (pre-1.0; new app surface — the pricing pivots)

Plan entry: [`docs/procurement-evaluation-plan.md` §1 / §7 · Track 4](../procurement-evaluation-plan.md)
· rolls up the `ProcurementResponse[]` built by [Thread 10](./thread-10-orchestration-use-cases.md)'s
`BuildEvaluationTable` and rendered flat by [Thread 12](./thread-12-in-app-review-grid.md);
mirrors Wayfinder's `computePivot` read-only ([ADR-0006](../adr/0006-inherit-wayfinder-auth-roles.adr.md), plan §9).

## Goal

The pricing **aggregates** (build plan §1): *pricing per brand (vendor)* and
*pricing per requirement/criterion*, plus a *brand × requirement* cross-tab, over
the real-number `estimateAud` the review grid already guarantees. Axis selection
(brand, requirement, brand×requirement) and a sum/average measure.

**Exit test:** pivot matches hand-computed totals on a fixture.

## What was built — `apps/redline-web`

Same posture as Threads 11–12: a **framework-free, unit-tested core** a thin
Next.js/React shell binds to (ADR-0006). The roll-up maths and the view shaping
are pure modules; the DOM stays dumb.

| File | Role |
|---|---|
| `src/lib/pricing-pivot.ts` | The **pivot brain** — `PricingPivot`. Rolls a `ProcurementResponse[]` up by `PivotAxis` (`brand` / `requirement` / `brand-x-requirement`) with a `sum` or `avg` measure over `estimateAud`. Mirrors `computePivot`'s algorithm — first-appearance distinct groups, ranked by descending measure total with an alphabetical tiebreak, a `sampleCount` tracking only rows that carried a figure — but over redline's own domain type. Returns `PricingPivotResult` (`primaryGroups`, `secondaryGroups`, `rows`, `columnTotals`, `grandTotal`, `hasNumericData`). |
| `src/lib/pricing-view.ts` | Pure `PricingPivotResult` → table transform (`renderPivotView`). Axis/measure headers, one column per secondary group for a cross-tab, currency-formatted cells for display, and a blank (not `$0.00`) cell where a group carried no figure. The numeric result stays the source of truth (the XLSX export, Thread 14, writes the real numbers, not these strings). |
| `src/lib/container.ts` | `WorkflowController.openPricingPivot({ evaluationId })` — reads the persisted `ProcurementResponse[]` via `IEvaluationRepository.listResponses` and wraps them in a `PricingPivot`. Read-only: pivots never mutate. |
| `src/index.ts` | Public surface — `PricingPivot`, `PIVOT_AXES`, `renderPivotView`, and their types. |
| `e2e/pricing-pivots.e2e.ts` | Playwright acceptance spec — per-brand, per-requirement, brand×requirement, and the sum/average toggle. |

## Design decisions

- **Reuse `computePivot`'s *algorithm*, not its *types*.** Wayfinder's
  `computePivot` operates on `FieldReportSessionRow`/`PivotColumn` — its own
  analytics data model, exposed from `@rbrasier/domain` (a **devDependency** of
  `redline-web`). Production app code imports nothing from Wayfinder (CLAUDE.md
  architecture rule). So `PricingPivot` reimplements the same deterministic
  shape — first-appearance distinct groups, rank-by-total desc with an
  alphabetical tiebreak, sum/avg with a `sampleCount` — over `ProcurementResponse[]`,
  and the exit test pins **parity against the real `computePivot`** in a
  test-only assertion. Exactly the posture Thread 12 used for `typedDisplayCell`.
- **Currency is a real number end to end.** The pivot sums/averages the domain's
  `estimateAud: number | null` (Thread 8/10) directly, so a total *is* a number
  (numeric sort/export, not a re-parsed string). `renderPivotView` formats only
  for display.
- **A null estimate is a non-sample, never a zero.** A description-fallback row
  (`estimateAud: null`, Thread 10) contributes no numeric sample: it is excluded
  from the sum, is not an average denominator, and renders as a blank cell — so
  an all-fallback pivot reports `hasNumericData: false` and blank totals rather
  than a misleading `$0.00`.
- **Brand × requirement is a cross-tab with brand primary.** The primary axis is
  vendor (ranked by total), the secondary is requirement; each row carries one
  cell per secondary group plus a row total, and `columnTotals` sum each
  requirement column — the `computePivot` two-axis shape.
- **Read-only open through the controller.** `openPricingPivot` reads
  `listResponses` and never writes — pivots are a read lens on the review-stage
  data `BuildEvaluationTable` already produced.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman):

```
@redline/redline-web:test → Test Files 7 passed (7) · Tests 45 passed (45)
  src/lib/workflow-manager.test.ts   (11)
  src/lib/container.test.ts          (8)   ← +1: openPricingPivot over persisted responses
  src/lib/view.test.ts               (2)
  src/lib/review-grid.test.ts        (8)
  src/lib/review-view.test.ts        (5)
  src/lib/pricing-pivot.test.ts      (7)   ← the exit test
  src/lib/pricing-view.test.ts       (4)

turbo typecheck / lint / test / build → all green across the @redline/* packages
./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The exit criterion — *pivot matches hand-computed totals on a fixture* — is
proven by `pricing-pivot.test.ts` on a five-row fixture (three vendors × two
requirements, with one null-estimate description-fallback row):
- **per brand, sum:** Initech `3000`, Globex `2000`, Acme `1500` (ranked desc);
  `grandTotal 6500`, `sampleCount 4` (the null row excluded).
- **per brand, avg:** Acme `(1000+500)/2 = 750`; Globex `2000/1` (null excluded);
  Initech `3000` — dividing only by numeric samples.
- **per requirement, sum:** residency `6000`, support `500`.
- **brand × requirement:** brand primary (ranked), requirement secondary; Acme's
  cells resolve `residency 1000`, `support 500`.
- **all-fallback:** `hasNumericData: false`, `grandTotal { value: 0, sampleCount: 0 }`.
- **parity:** agrees with Wayfinder's `computePivot` on the same data projected
  onto its `FieldReportSessionRow` shape (test-only, no production Wayfinder import).

`pricing-view.test.ts` proves the view model (headers/labels, currency
formatting, the blank no-figure cell, one column per secondary group);
`container.test.ts` proves `openPricingPivot` reads the persisted responses and
rolls them up per brand.

## Known limitations / follow-ups

1. **No Next.js shell yet.** The pivot logic is complete and tested; the
   route/DOM layer that binds to `renderPivotView` and runs the Playwright e2e is
   the Track 4 shell follow-up (shared with Threads 11–12).
   `e2e/pricing-pivots.e2e.ts` pins the `/evaluations/:id/pivots` DOM contract.
   Deviation recorded in `.claude/CLAUDE.md`.
2. **Excel export is Thread 14.** The XLSX path writes one sheet per pivot,
   reusing the same numeric-currency guarantee (the `PricingPivotResult` numbers,
   not the formatted display strings).
3. **No live end-to-end run** (no browser/app server here); the pivots are proven
   against the built `ProcurementResponse[]` in memory, the Threads 5–12 posture.
