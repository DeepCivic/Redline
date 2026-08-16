# @redline/redline-web

The **corpus control surface**: the Create Corpus ingest brain (run name,
raw-document upload, the allow-listed config overrides, and the run trigger), the
run tracker's view model, and the report sheet seam. It names and fires a run over
unextracted documents, and follows that run to a terminal state; what the run lands
is then read by `apps/redline-mcp`'s report tools.

This is an **app**: it imports only `@redline/redline-domain` (ports and types).
The concrete adapters (the womblex sidecar client, the MinIO staged-corpus writer,
the Drizzle staged-corpus reader) are injected as ports through
[`src/lib/container.ts`](./src/lib/container.ts) — the one place wiring lives
(CLAUDE.md architecture rule). Nothing here constructs an adapter directly.

## Layout

| File | Role |
|---|---|
| `src/lib/container.ts` | `CorpusController` over a three-port `CorpusContainer`. Three ports because a corpus has exactly three moments: the bytes go in (`IStagedCorpusWriter`), the run fires and is watched (`IWomblexRunTrigger`), and what it landed is listed back (`IStagedCorpusReader`). It exposes the two staged-corpus reads directly and hands out the run-side controllers (`corpus()` → `CreateCorpusController`, `runStatus()` → `RunStatusController`), so the served router reaches the whole surface through one object. |
| `src/lib/create-corpus-view.ts` | Pure draft → view-model transform for the **Create Corpus** surface. Shapes the three things the form authors: the run-name field, the pending document uploads (chosen but not yet staged — no document identity, since womblex mints each `source_hash` on extract), and the allow-listed config overrides (stage-sequence toggles, chunk mode, money vocabulary — blank inherits the `redline.yaml` default, `inheritsDefault` says so). `trigger.enabled` owns the rule that a run needs a name, at least one document and at least one stage — not the shell. `AUTHORABLE_STAGES` / `DEFAULT_STAGE_SEQUENCE` are the allow-list defaults. |
| `src/lib/create-corpus-controller.ts` | `CreateCorpusController` is the surface's **write brain**: it owns the two write seams (`IStagedCorpusWriter`, `IWomblexRunTrigger`). `stageDocument` / `startRun` are the individual steps; `createCorpus` is the cold-start sequence — stage every chosen document under the run's own name, then fire the run. A failed stage never fires (a run over a half-staged prefix would extract part of the corpus and report success), a nameless or document-less run is refused before staging anything, and every seam error returns as a `Result`. |
| `src/lib/run-status-view.ts` | Pure `RunStatusView` → view-model transform for the run tracker. Reduces a minutes-long womblex run to the four states the served route renders — **started** (`isRunning`), **errored** (`isErrored` + `failedStage` + `errorMessage`), **resumable** (`canResume`), **done** (`isComplete`) — with `shouldKeepPolling` owning the invariant that a failed stage names itself and offers resume rather than spinning forever. |
| `src/lib/run-status-controller.ts` | `RunStatusController` drives the run seam (`IWomblexRunTrigger`, architecture §3/§5): `start` a run, `poll` it into the `RunStatusViewModel`, `resume` by re-firing the same trigger (the engine's idempotent enqueue makes resume free). Seam errors return as `Result`s, never thrown across the boundary. Builds nothing of its own — it does not reimplement the engine's batching, retry or scale-out. |
| `src/lib/report-export.ts` | The **report sheet seam**: the deterministic half where an *assembled report* (an ordered list of provenance-grounded `{ heading, body, transferredPassages, financialExpressions, unreachable }` sections — architecture §5.1) becomes sheet data. `buildReportSheetData` renders one report to a sheet — a graph-availability header, then each section in order, with every transferred passage keeping its `chunkId` citation and every financial expression keeping its exact `value`/`currency`/provenance anchor (passage text byte-identical, value uninterpreted); an unreachable section renders its note, never invented prose. `buildReportWorkbook` wraps it as a `ReportWorkbook`, and `toWriterSheets` / `writeReportWorkbook` serialise it through the lazy `write-excel-file/browser` writer. The `AssembledReport` shape is declared here (structurally mirroring the fork-side `ReportAssembler`'s output) so the loop's output crosses as plain data — redline-web never imports the fork. |

## Validation & the exit test

`pnpm --filter @redline/redline-web test` runs the vitest suite: the corpus
controller reaching each of its three seams and returning a seam error as a
`Result`, the Create Corpus brain's staging-then-firing order and its refusals,
the readiness and override rules of the view model, the run tracker's four states,
and the report sheet's provenance-preserving cell shape.

### Running the e2e

The Playwright acceptance spec lives in the **forked Wayfinder** at
`services/wayfinder/apps/web/e2e/redline-create-corpus.spec.ts`. It runs against
the fork's served `apps/web`, which mounts these brains + view models (the
`corpus` tRPC router and the `create-corpus` `"use client"` surface) at
`/create-corpus`. Next.js/React matches Wayfinder's own `apps/web`, so the
plugin's control surface feels at home in Wayfinder.

The vitest suite above stays the framework-free proof of the brains + view models;
the fork spec pins the served DOM they bind to. The tab, its permission gate, the
readiness rule, the upload list and the override editors need nothing staged and
always run. Firing a real run gates on `E2E_REDLINE_RUN_STACK` (a reachable
womblex-ingest sidecar and object storage) — this surface stages its own
documents, so it needs no pre-staged corpus. That live half splits again on
`E2E_REDLINE_ISAACUS`, which is a question about cost rather than infrastructure:
a run over the offline stages (extraction plus `money`) drives the whole
browser → object store → engine → tracker path for nothing, while `chunk` /
`embed` / `enrich` are Isaacus spend.
