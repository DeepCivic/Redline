# @redline/redline-web

The specialist **control surface** (workflow manager) for a procurement
evaluation, and — from Thread 12 — the sortable in-app review grid.

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
| `e2e/workflow-manager.e2e.ts` | Playwright acceptance spec for the three shapes + a stage advance. |

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
