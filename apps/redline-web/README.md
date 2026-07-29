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
| `src/lib/excel-export.ts` | The **export brain**: pure builders that turn the review grid + pricing pivots into `write-excel-file` sheet data — numeric currency cells, a source hyperlink per row, one `Review` sheet + one sheet per pivot — plus `exportEvaluationXlsx`, a lazy `write-excel-file/browser` trigger. Reuses Wayfinder's XLSX cell shape (plan §9) so currency stays a real numeric cell. |
| `e2e/workflow-manager.e2e.ts` | Playwright acceptance spec for the three shapes + a stage advance. |
| `e2e/review-grid.e2e.ts` | Playwright acceptance spec for the review grid (all columns render, currency sorts numerically, source deep-links resolve, requirement filter). |
| `e2e/pricing-pivots.e2e.ts` | Playwright acceptance spec for the pricing pivots (per-brand, per-requirement, brand×requirement, sum/average toggle). |
| `e2e/excel-export.e2e.ts` | Playwright acceptance spec for the Excel export ("Export to Excel" downloads a dated `.xlsx` that opens). |

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

`e2e/workflow-manager.e2e.ts` is the Playwright acceptance artifact. It runs once
a Next.js shell serves the routes it drives (`/evaluations/:id/grouping`) — a
follow-up within Track 4. Next.js/React matches Wayfinder's own `apps/web`
(ADR-0006), so the adapter's control surface feels at home in Wayfinder rather
than borrowing Numbatch's (unused) SvelteKit stack. In the current build
environment there is no browser or
app server (the same standalone posture as the service threads' captured-payload
contract tests), so the vitest suite above is the proven exit gate; the e2e spec
pins the DOM contract for when the shell lands. This deviation is recorded in
[`.claude/CLAUDE.md`](../../.claude/CLAUDE.md).
