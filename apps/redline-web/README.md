# @redline/redline-web

The specialist **control surface** (workflow manager) for a procurement
evaluation, the sortable in-app **review grid**, and — from delivery-plan §2
item 1 — the **Create Corpus** ingest surface (run name, raw-document upload,
the allow-listed config overrides, and the run trigger). It names and fires a
run over unextracted documents; `/evaluations/new` composes the evaluation over
the corpus the run produces, so brands and fields are named against real
documents the engine has read.

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
| `src/lib/container.ts` | `WorkflowController` wires the real use-cases (`IngestDocuments`, `AssignDocumentsToGroups`, `ClassifyResponseGroup`, `BuildEvaluationTable`, `CreateEvaluation`) from injected ports and drives the workflow: open a manager for the grouping stage, `advance` (persist the composition + advance the stage), `reclassifyGroup`, `buildTable`. `populate` is the post-run reading pass (delivery-plan §2 item 1): it takes a settled evaluation — created over a finished corpus, its groups and lens persisted but no responses — through `IngestDocuments` → `advance` (over the persisted groups) → `buildTable`, and is re-runnable, returning the existing response set untouched rather than double-writing it when a resumed run finds one already built. It also composes and exposes the run-side controllers over the two write seams (`corpus()` → `CreateCorpusController`, `runStatus()` → `RunStatusController`), so the served router reaches the whole create-and-run surface through one object. `buildContainer` is the production-wiring factory. |
| `src/lib/view.ts` | Pure snapshot → view-model transform the Next.js/React shell binds to (stage label, document tray, per-group counts, the advance affordance). Keeps the DOM dumb and the presentation logic tested. |
| `src/lib/review-grid.ts` | The **review grid brain**: turns the `BuildEvaluationTable` output (one `ProcurementResponse` per (group, document, matched requirement)) into typed, sortable, filterable rows. Currency routes through Wayfinder's `typedDisplayCell` so it stays a real number — it sorts numerically and exports numeric. Each row carries source provenance (document / element / page / chunk) for a deep-link. |
| `src/lib/review-view.ts` | Pure `ReviewGrid` → view-model transform: header cells (active sort + next-click direction), sorted/filtered body rows, and a resolved source deep-link `href` per row. |
| `src/lib/pricing-pivot.ts` | The **pivot brain**: rolls the `ProcurementResponse[]` up per brand, per requirement, or brand×requirement, summing/averaging the real-number `estimateAud` — mirroring Wayfinder's `computePivot` algorithm over redline's own domain type. |
| `src/lib/pricing-view.ts` | Pure `PricingPivotResult` → table transform: axis/measure headers, one column per secondary group, currency-formatted display cells (the numeric result stays the source of truth). |
| `src/lib/excel-export.ts` | The **export brain**: pure builders that turn the review grid + pricing pivots into `write-excel-file` sheet data — numeric currency cells, a source hyperlink per row, one `Review` sheet + one sheet per pivot. `buildEvaluationWorkbook` produces the `EvaluationWorkbook`; `toWriterSheets` pairs each sheet's data with its name; `writeEvaluationWorkbook` is the lazy `write-excel-file/browser` trigger that writes an **already-built** workbook (so the fork's mount builds it server-side and the browser only writes it); `exportEvaluationXlsx` builds-then-writes for a caller that holds the grid + pivot. Reuses Wayfinder's XLSX cell shape (plan §9) so currency stays a real numeric cell. |
| `src/lib/run-status-view.ts` | Pure `RunStatusView` → view-model transform for the Create Corpus run tracker. Reduces a minutes-long womblex run to the four states the served route renders — **started** (`isRunning`), **errored** (`isErrored` + `failedStage` + `errorMessage`), **resumable** (`canResume`), **done** (`isComplete`) — with `shouldKeepPolling` owning the invariant that a failed stage names itself and offers resume rather than spinning forever. |
| `src/lib/run-status-controller.ts` | `RunStatusController` drives the run seam (`IWomblexRunTrigger`, architecture §3/§5): `start` a run, `poll` it into the `RunStatusViewModel`, `resume` by re-firing the same trigger (the engine's idempotent enqueue makes resume free). Seam errors return as `Result`s, never thrown across the boundary. Builds nothing of its own — it does not reimplement the engine's batching, retry or scale-out. |
| `src/lib/create-corpus-view.ts` | Pure draft → view-model transform for the **Create Corpus** ingest surface. Shapes the three things the form authors: the run-name field, the pending document uploads (chosen but not yet staged — no document identity, since womblex mints each `source_hash` on extract), and the allow-listed config overrides (stage-sequence toggles, chunk mode, money vocabulary — blank inherits the `redline.yaml` default, `inheritsDefault` says so). `trigger.enabled` owns the rule that a run needs a name, at least one document and at least one stage — not the shell. `AUTHORABLE_STAGES` / `DEFAULT_STAGE_SEQUENCE` are the allow-list defaults. There is no staged-corpus picker and no brand/field input: those belong on `/evaluations/new`, which composes the evaluation over the finished corpus. |
| `src/lib/create-corpus-controller.ts` | `CreateCorpusController` is the surface's **write brain**: it owns the two write seams (`IStagedCorpusWriter`, `IWomblexRunTrigger`) and no create seam at all — an evaluation cannot name brands or fields against documents the run has not yet read. `stageDocument` / `startRun` are the individual steps; `createCorpus` is the cold-start sequence, minus the manifest — stage every chosen document under the run's own name, then fire the run that ingest → lens → grouping → build hangs off. A failed stage never fires (a run over a half-staged prefix would extract part of the corpus and report success), a nameless or document-less run is refused before staging anything, and every seam error returns as a `Result`. |
| `src/lib/report-export.ts` | The **report sheet seam**: the deterministic half where an *assembled report* (an ordered list of provenance-grounded `{ heading, body, transferredPassages, financialExpressions, unreachable }` sections — architecture §5.1) becomes sheet data. `buildReportSheetData` renders one report to a sheet — a graph-availability header, then each section in order, with every transferred passage keeping its `chunkId` citation and every financial expression keeping its exact `value`/`currency`/provenance anchor (passage text byte-identical, value uninterpreted); an unreachable section renders its note, never invented prose. `buildReportWorkbook` wraps it as an `EvaluationWorkbook`, so it flows through the same `toWriterSheets`/`writeEvaluationWorkbook` writer the evaluation workbook uses. The `AssembledReport` shape is declared here (structurally mirroring the fork-side `ReportAssembler`'s output) so the loop's output crosses as plain data — redline-web never imports the fork. |
| `e2e/` (moved) | The Playwright acceptance specs now live in the **forked Wayfinder** at `services/wayfinder/apps/web/e2e/redline-*.spec.ts` (ADR-0019) — the review grid, pricing pivots, Excel export and grouping surface, run against the served fork rather than a headless brain. |

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
group can be (re)classified and the table built (`classifying → review`). It
also pins post-run population (delivery-plan §2 item 1): `populate` over a
settled evaluation with staged documents and no responses leaves the response
set the review grid reads, and a second run — or a resume of one that crashed
mid-flight — leaves the same set rather than a doubled one.

### Running the e2e

The Playwright acceptance specs live in the **forked Wayfinder** at
`services/wayfinder/apps/web/e2e/redline-*.spec.ts` (ADR-0019). They run against
the fork's served `apps/web`, which mounts these brains + view models (the
`evaluation` tRPC router + the `components/evaluation/*` `"use client"` surfaces)
at `/evaluations/:id/{review,pivots,grouping}`. Next.js/React matches Wayfinder's
own `apps/web` (ADR-0006), so the adapter's control surface feels at home in
Wayfinder rather than borrowing Numbatch's (unused) SvelteKit stack.

The vitest suite above stays the framework-free proof of the brains + view
models; the fork specs pin the served DOM the brains bind to, gated on
`E2E_REDLINE_EVALUATION_ID` (a real redline evaluation, which lands with the live
`getContainer()` wiring) and skipping otherwise, matching the fork's other
seed-gated phase specs. Pointing the specs at the served fork closes the `/e2e`
deviation that `.claude/CLAUDE.md` recorded while there was no browser or app
server to target.

The grouping spec pins only what the fork serves today — the grouping landing
and its navigation into the read-side review and pricing screens. The interactive
composition surface (drag documents into response groups, mark consortiums,
advance the stage over the `WorkflowManager`) is deferred (the lens stage
machine), so it stays proven in the vitest suite only.
