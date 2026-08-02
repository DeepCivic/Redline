# @redline/redline-web

The specialist **control surface** (workflow manager) for a procurement
evaluation, and — from Thread 12 — the sortable in-app **review grid**.

This is an **app**: it imports only `@redline/redline-application` (the
orchestration use-cases) and `@redline/redline-domain` (ports and types). The
concrete adapters (Numbatch classifier, womblex reader, Drizzle repository, the
language model) are injected as ports through
[`src/lib/container.ts`](./src/lib/container.ts) — the one place wiring lives
(CLAUDE.md architecture rule). Nothing here constructs an adapter directly.

## Layout

| File | Role |
|---|---|
| `src/lib/workflow-manager.ts` | The **brain**: a pure, in-memory model of "drag documents into response groups". Add vendors, create groups, assign/move/unassign documents, mark consortiums, split a vendor's multiple bids — the three relationship shapes (build plan §5). Every mutation is checked through the same `redline-domain` smart constructors the use-case uses, so the UI can never compose a shape the application layer would reject. Emits an `AssignDocumentsToGroupsInput` via `toAssignmentInput()`. |
| `src/lib/container.ts` | `WorkflowController` wires the real use-cases (`AssignDocumentsToGroups`, `ClassifyResponseGroup`, `BuildEvaluationTable`) from injected ports and drives the workflow: open a manager for the grouping stage, `advance` (persist the composition + advance the stage), `reclassifyGroup`, `buildTable`. `buildContainer` is the production-wiring factory. |
| `src/lib/view.ts` | Pure snapshot → view-model transform the Next.js/React shell binds to (stage label, document tray, per-group counts, the advance affordance). Keeps the DOM dumb and the presentation logic tested. |
| `src/lib/review-grid.ts` | The **review grid brain**: turns the `BuildEvaluationTable` output (one `ProcurementResponse` per (group, document, matched requirement)) into typed, sortable, filterable rows. Currency routes through Wayfinder's `typedDisplayCell` so it stays a real number — it sorts numerically and exports numeric. Each row carries source provenance (document / element / page / chunk) for a deep-link. |
| `src/lib/review-view.ts` | Pure `ReviewGrid` → view-model transform: header cells (active sort + next-click direction), sorted/filtered body rows, and a resolved source deep-link `href` per row. |
| `src/lib/pricing-pivot.ts` | The **pivot brain**: rolls the `ProcurementResponse[]` up per brand, per requirement, or brand×requirement, summing/averaging the real-number `estimateAud` — mirroring Wayfinder's `computePivot` algorithm over redline's own domain type. |
| `src/lib/pricing-view.ts` | Pure `PricingPivotResult` → table transform: axis/measure headers, one column per secondary group, currency-formatted display cells (the numeric result stays the source of truth). |
| `src/lib/excel-export.ts` | The **export brain**: pure builders that turn the review grid + pricing pivots into `write-excel-file` sheet data — numeric currency cells, a source hyperlink per row, one `Review` sheet + one sheet per pivot. `buildEvaluationWorkbook` produces the `EvaluationWorkbook`; `toWriterSheets` pairs each sheet's data with its name; `writeEvaluationWorkbook` is the lazy `write-excel-file/browser` trigger that writes an **already-built** workbook (so the fork's mount builds it server-side and the browser only writes it); `exportEvaluationXlsx` builds-then-writes for a caller that holds the grid + pivot. Reuses Wayfinder's XLSX cell shape (plan §9) so currency stays a real numeric cell. |
| `e2e/` (moved) | The Playwright acceptance specs now live in the **forked Wayfinder** at `services/wayfinder/apps/web/e2e/redline-*.spec.ts` (ADR-0019, delivery-plan item 1 step 2) — the review grid, pricing pivots, Excel export and grouping surface, run against the served fork rather than a headless brain. |

## The three relationship shapes

The workflow manager composes all of build plan §5's many-to-many shapes:

1. **one vendor → N docs → one response** — one vendor, one group, drag many docs in;
2. **N vendors → one consortium response** — a group with `>1` vendor is flagged `isConsortiumResponse`, and `markConsortium` records the consortium vendor with its members;
3. **one vendor → N responses** — the same vendor across multiple groups (split multi-bid).

## Validation & the exit test

`pnpm --filter @redline/redline-web test` runs the vitest suite. This is the
**executable exit test** for Thread 11: it exercises the same `WorkflowManager`
+ `WorkflowController` the DOM binds to, proving the three shapes compose, that
an empty composition cannot advance, that a valid one persists via
`AssignDocumentsToGroups` and advances `grouping → classifying`, and that a
group can be (re)classified and the table built (`classifying → review`).

### Running the e2e

The Playwright acceptance specs live in the **forked Wayfinder** at
`services/wayfinder/apps/web/e2e/redline-*.spec.ts` (ADR-0019, delivery-plan
item 1 step 2). They run against the fork's served `apps/web`, which mounts these
brains + view models (the `evaluation` tRPC router + the `components/evaluation/*`
`"use client"` surfaces) at `/evaluations/:id/{review,pivots,grouping}`.
Next.js/React matches Wayfinder's own `apps/web` (ADR-0006), so the adapter's
control surface feels at home in Wayfinder rather than borrowing Numbatch's
(unused) SvelteKit stack.

The vitest suite above stays the framework-free proof of the brains + view
models; the fork specs pin the served DOM the brains bind to, gated on
`E2E_REDLINE_EVALUATION_ID` (a real redline evaluation, which lands with the live
`getContainer()` wiring — delivery-plan item 2) and skipping otherwise, matching
the fork's other seed-gated phase specs. Pointing the specs at the served fork
closes the `/e2e` deviation that `.claude/CLAUDE.md` recorded while there was no
browser or app server to target.

The grouping spec pins only what the fork serves today — the grouping landing
and its navigation into the read-side review and pricing screens. The interactive
composition surface (drag documents into response groups, mark consortiums,
advance the stage over the `WorkflowManager`) is deferred to the lens stage
machine (delivery-plan §3), so it stays proven in the vitest suite only.
