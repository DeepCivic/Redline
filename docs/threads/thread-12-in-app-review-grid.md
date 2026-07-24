# Thread 12 — In-app review grid (priority 1)

**Status:** ✅ Complete · **Date:** 2026-08-02 · **Version intent:** MINOR (pre-1.0; new app surface — the review grid)

Plan entry: [`docs/procurement-evaluation-plan.md` §1 / §5 · Track 4](../procurement-evaluation-plan.md)
· renders the `ProcurementResponse[]` built by [Thread 10](./thread-10-orchestration-use-cases.md)'s
`BuildEvaluationTable`, driven through the control surface from [Thread 11](./thread-11-workflow-manager-ui.md);
reuses Wayfinder's `typedDisplayCell` read-only ([ADR-0006](../adr/0006-inherit-wayfinder-auth-roles.adr.md)).

## Goal

The sortable, filterable **in-app review grid** — the product's priority-1
surface (build plan §1). One row per (group, document, matched requirement) — the
review grid's natural unit (§5) — with every required column: vendor, product,
requirement, confidence, summary, estimate (AUD), costing, and a **source column
that deep-links to the exact document location**.

**Exit test:** a real evaluation renders; currency sorts numerically; source
links resolve.

## What was built — `apps/redline-web`

Same posture as Thread 11: a **framework-free, unit-tested core** a thin
Next.js/React shell binds to (ADR-0006 — the shell matches Wayfinder's own
`apps/web`). The interesting logic (typing, sorting, filtering, deep-link
resolution) lives in pure modules; the DOM stays dumb.

| File | Role |
|---|---|
| `src/lib/review-grid.ts` | The **grid brain** — `ReviewGrid`. Turns the `ProcurementResponse[]` into typed `ReviewRow`s (`REVIEW_COLUMNS` in display order), each cell resolved to `{ display, sortValue, isNumeric }`. `view({ sort, filter })` returns the sorted/filtered rows the shell renders; `all()` is the default view; `requirementIds()` feeds the filter dropdown. Currency stays a real number end-to-end, so it sorts numerically; a null estimate (the Thread 10 description-fallback signal) is never marked numeric and clusters at the numeric floor. |
| `src/lib/review-view.ts` | Pure `ReviewGrid` → view-model transform (`renderReviewGridView`). Header cells with the active sort + next-click direction, sorted/filtered body cells in column order, and a resolved **source deep-link `href`** per row (`/evaluations/:id/documents/:documentId?element=…&page=…&chunk=…`). |
| `src/lib/container.ts` | `WorkflowController.openReviewGrid({ evaluationId })` — reads the persisted `ProcurementResponse[]` via `IEvaluationRepository.listResponses` and wraps them in a `ReviewGrid`. Read-only: the grid never mutates, so it returns the grid, not a stage transition. |
| `src/index.ts` | Public surface — `ReviewGrid`, `REVIEW_COLUMNS`, `renderReviewGridView`, and their types. |
| `e2e/review-grid.e2e.ts` | Playwright acceptance spec — all columns render, currency sorts numerically, the source column deep-links, the requirement filter narrows the grid. |

### The columns (build plan §1 "per response, capture")

`vendor · product · requirement · confidence · summary · estimate (AUD) ·
costing · source`. Only **source** is unsortable — it is a provenance link, not a
comparable value. `estimate (AUD)` and `confidence` are numeric columns (sort by
number, right-alignable, export-numeric); the rest are text.

## Design decisions

- **Framework-free core; a dumb DOM.** The grid's typing/sorting/filtering and
  the view model are pure and vitest-tested, so the exit criterion is provable
  without a browser — the same posture as Thread 11's workflow core. A Next.js
  shell binds to `renderReviewGridView` and dispatches sort/filter changes.
- **Currency is a real number, proven against Wayfinder's own helper.** The
  domain already carries `estimateAud: number | null` (Thread 8/10), so the
  grid's currency sort key *is* the figure — a numeric sort, not a lexical one.
  The exit test pins that numeric contract against Wayfinder's
  `typedDisplayCell("currency", …)` → `{ value, isNumeric: true }` (the read-only
  reuse the plan §9 / ADR-0006 calls for, and the same property the pivots
  (Thread 13) and the XLSX export (Thread 14) depend on). Production grid code
  imports nothing from Wayfinder; the assertion is test-only (matching the Thread
  8 adapter's posture), so the app keeps its allowed dependency set.
- **The source column deep-links to the exact location.** Each row carries the
  womblex provenance (`documentId` = source_hash, `elementOrder`, `page`,
  `chunkId`); `renderReviewGridView` resolves it to a stable
  `/evaluations/:id/documents/:documentId?element=…` href (page/chunk added only
  when present). The route space is the shell's; this is the contract the e2e
  pins.
- **A null estimate never masquerades as a figure.** The description-fallback
  rows (`estimateAud: null`, Thread 10) render an empty currency cell, are never
  `isNumeric`, and sort to the numeric floor so "no figure yet" rows cluster
  rather than scatter through a currency sort.
- **Stable sort.** Equal keys keep build order, so a re-sort is deterministic and
  a text sort is case-insensitive without losing input order among ties.
- **Read-only open through the controller.** `openReviewGrid` reads
  `listResponses` and never writes — the review stage is a read surface; building
  the rows is Thread 10's `BuildEvaluationTable` (`classifying → review`), already
  done before the grid opens.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman):

```
@redline/redline-web:test → Test Files 5 passed (5) · Tests 33 passed (33)
  src/lib/workflow-manager.test.ts   (11)
  src/lib/container.test.ts          (7)   ← +2: openReviewGrid over persisted responses (currency numeric) + empty grid
  src/lib/view.test.ts               (2)
  src/lib/review-grid.test.ts        (8)   ← the exit test
  src/lib/review-view.test.ts        (5)   ← header sort state + source deep-link href + requirement filter + empty

turbo typecheck / lint / test / build → all green across the @redline/* packages
./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The exit criterion — *a real evaluation renders; currency sorts numerically;
source links resolve* — is proven by:
- `review-grid.test.ts`: a `ProcurementResponse[]` renders one typed row per
  (group, document, requirement); the currency cell is numeric
  (`typedDisplayCell("currency", "1500.5")` → `{ value: 1500.5, isNumeric: true }`,
  cell `sortValue === 1500.5`); a currency sort orders `[90, 100, 1000]` (not the
  lexical `[100, 1000, 90]`); text sorts case-insensitively and stably; null
  estimates cluster and stay non-numeric; free-text and requirement filters
  narrow the grid; the source column refuses to sort.
- `review-view.test.ts`: the source deep-link resolves to
  `/evaluations/eval-1/documents/doc-a?element=7&page=3&chunk=doc-a%3A2` (and
  drops page/chunk when absent); header state reflects the active + next-click
  sort direction; the requirement filter applies; an empty evaluation renders an
  empty grid.
- `container.test.ts`: `openReviewGrid` reads the persisted responses into a
  `ReviewGrid` with a numeric estimate and intact source provenance, and opens
  empty when nothing was built yet.

## Known limitations / follow-ups

1. **No Next.js shell yet.** The grid logic is complete and tested; the route/DOM
   layer that binds to `renderReviewGridView` and runs the Playwright e2e is the
   Track 4 shell follow-up (shared with Thread 11). `e2e/review-grid.e2e.ts` pins
   the DOM contract (`/evaluations/:id/review`, `data-testid` hooks) for when it
   lands. Deviation recorded in `.claude/CLAUDE.md`.
2. **Pricing pivots are Thread 13.** The grid is the flat, sortable table; the
   per-brand / per-requirement roll-ups (reusing `computePivot`) are the next
   thread. Excel export (Thread 14) reuses the same numeric currency guarantee.
3. **One `productName` per evaluation.** Carried from Threads 10–11 — the grid
   shows whatever `BuildEvaluationTable` produced.
4. **No live end-to-end run** (no browser/app server here); the grid is proven
   against the built `ProcurementResponse[]` in memory, the same standalone
   posture as Threads 5–11.
