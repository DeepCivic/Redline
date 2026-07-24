# Thread 11 — Workflow manager UI (specialist control surface)

**Status:** ✅ Complete · **Date:** 2026-08-01 · **Version intent:** MINOR (pre-1.0; first app surface)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 4](../procurement-evaluation-plan.md)
· drives the use-cases from [Thread 10](./thread-10-orchestration-use-cases.md) over the
domain ports/entities from [Thread 2](./thread-02-redline-domain-entities-and-ports.md) /
[Thread 2a](./thread-02a-generalise-requirements.md).

## Goal

The specialist **control surface**: drag documents into response groups, mark
consortiums, split a vendor's multiple bids, drive `IntakeStage`, and trigger
(re)classification per group.

**Exit test:** the specialist can compose the three relationship shapes and
advance stages.

## What was built — `apps/redline-web`

The first app in the workspace. It imports only `@redline/redline-application`
(use-cases) and `@redline/redline-domain` (ports/types); the concrete adapters
are injected as ports through `src/lib/container.ts` — the one place wiring
lives (CLAUDE.md architecture rule). Nothing in the app constructs an adapter.

| File | Role |
|---|---|
| `src/lib/workflow-manager.ts` | The **brain** — a pure, in-memory model of "drag documents into response groups". `addVendor`, `createGroup`, `assignDocument` (a doc lives in exactly one group; dropping it on another *moves* it), `unassignDocument`, `markConsortium`, `toAssignmentInput()`, `canAdvance()`/`nextStage()`, `snapshot()`. Every mutation is checked through the same `redline-domain` smart constructors (`makeVendor`, `makeResponseGroup`) the use-case uses, so the UI can never compose a shape the application layer would reject. |
| `src/lib/container.ts` | `WorkflowController` wires `AssignDocumentsToGroups`, `ClassifyResponseGroup`, `BuildEvaluationTable` from injected ports and drives the workflow (`openWorkflow`, `advance`, `reclassifyGroup`, `buildTable`). `buildContainer` is the production-wiring factory. |
| `src/lib/view.ts` | Pure snapshot → view-model transform the Next.js/React shell binds to (stage label, document tray, per-group counts + consortium badge, the advance affordance). |
| `src/index.ts` | Public surface — manager, controller, container factory, view model. |
| `e2e/workflow-manager.e2e.ts` | Playwright acceptance spec (three shapes + a stage advance). |
| `package.json` / `tsconfig.json` / `vitest.config.ts` / `README.md` | App scaffold; `e2e/` excluded from tsc/lint/vitest scope. |

### The three relationship shapes (build plan §5)

1. **one vendor → N docs → one response** — one vendor, one group, many docs dragged in;
2. **N vendors → one consortium response** — a group with `>1` vendor is flagged
   `isConsortiumResponse`, and `markConsortium` records the consortium vendor with its members;
3. **one vendor → N responses** — the same vendor across multiple groups (split multi-bid).

## Design decisions

- **A framework-free, unit-tested core; a dumb DOM.** The workflow logic lives in
  `WorkflowManager` (state) + `view.ts` (presentation model), both pure and
  vitest-tested. A Next.js/React shell (matching Wayfinder's `apps/web` — ADR-0006)
  binds to the view model and dispatches to
  the manager. This keeps the exit criterion provable without a browser and keeps
  the interesting logic out of untestable markup.
- **The UI reuses the domain's smart constructors.** `createGroup`/`markConsortium`/
  `toAssignmentInput` validate through `makeVendor`/`makeResponseGroup`, so a
  composition that would fail `AssignDocumentsToGroups` fails *at the point of
  composition* in the UI, not later.
- **A document belongs to exactly one group.** `assignDocument` removes the doc from
  every other group first, so "drag onto a new group" is a move — matching the §5
  model (a response has N docs; a doc has one response).
- **Wiring is one factory + injected ports.** `WorkflowController` never sees a
  concrete adapter; `buildContainer` assembles the production container in one place
  (deployment / Thread 16). The controller/manager are exercised in tests with
  in-memory fakes — the same standalone posture as Threads 5–10.
- **`/e2e` deviation recorded.** The Playwright spec is authored now; its executable
  gate is the vitest suite until a Next.js shell serves the routes. Noted in the
  CLAUDE.md deviations table.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman):

```
@redline/redline-web:test → Test Files 3 passed (3) · Tests 18 passed (18)
  src/lib/workflow-manager.test.ts   (11)  ← the three shapes + move/unassign + validation + advance eligibility
  src/lib/container.test.ts          (5)   ← open/advance (grouping→classifying), reclassify, build table (classifying→review)
  src/lib/view.test.ts               (2)   ← view model (tray, counts, consortium badge, advance affordance)

turbo typecheck / lint / test / build → all green across 5 @redline/* packages
./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The exit criterion — *compose the three relationship shapes and advance stages* —
is proven by:
- `workflow-manager.test.ts`: shape 1 (one vendor, two docs, one group,
  `isConsortiumResponse: false`), shape 2 (two-vendor group flagged consortium +
  `markConsortium` recording members), shape 3 (one vendor across two groups); plus
  that an empty composition cannot advance and a populated one reports
  `nextStage: "classifying"`;
- `container.test.ts`: a composed workflow persists via `AssignDocumentsToGroups` and
  advances `grouping → classifying`, an empty one is refused, a single group can be
  (re)classified, and `buildTable` advances `classifying → review` with a real
  `estimateAud` on the produced response.

## Known limitations / follow-ups

1. **No Next.js shell yet.** The control surface's logic is complete and tested;
   the route/DOM layer that binds to the view model and runs the Playwright e2e is a
   Track 4 follow-up. The e2e spec pins the DOM contract (`/evaluations/:id/grouping`,
   `data-testid` hooks) for when it lands.
2. **One `productName` per evaluation.** Carried from Thread 10 — `buildTable` still
   takes a single product name via the container; per-group product names need a
   capture surface and a `BuildEvaluationTable` change.
3. **No live end-to-end run** (no Numbatch/DB/model/browser here) — the controller is
   proven against in-memory fakes, the same standalone posture as Threads 5–10. A real
   wiring smoke lands with Thread 16.
4. **Auth/roles (plan decision #5) still open.** The control surface does not yet
   gate on a user/role; decide before the shell ships.
