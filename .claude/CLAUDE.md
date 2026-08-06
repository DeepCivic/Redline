# CLAUDE.md — Routing Index (redline)

> **Procurement Evaluation Adapter.** A Wayfinder plugin in its own repo. This file
> adapts Wayfinder's engineering conventions; where we deliberately deviate, it is
> called out explicitly under **Deliberate deviations from Wayfinder**.

## Default Behaviour

**Answer general questions directly.** Do not invoke a skill for explanations,
comparisons, architecture questions, or anything that doesn't require writing new
code or documentation.

Invoke a skill only when the user is explicitly planning, reviewing, building,
changing, or fixing something. When a skill applies, state:
`Applying skill: /[command] because [one-line reason]`

All skill commands live in `.claude/commands/`. After any skill that writes code,
run `./validate.sh` and fix all failures before declaring done.

---

## Skill Routing

| If the user is asking to…                                        | Run            |
| ---------------------------------------------------------------- | -------------- |
| Plan a new build step or component (add/refine an item in the plan) | Answer directly — **stop there** |
| Implement an outstanding item from the delivery plan, write code | `/build`       |
| Change or extend something already built                         | `/enhance`     |
| Fix something broken or not working                              | `/bugfix`      |
| Review a planned build step, only when explicitly asked          | `/doc-review`  |
| Anything else                                                    | Answer directly |

Planning new work is not its own skill: add or refine the item directly in
`docs/delivery-plan.md` (§2/§3) against the build-step contract in §1 — one build
step including its test, one commit, one package where possible, an explicit
`_Exit: …_` test. Split the item if its exit test joins two independently-testable
behaviours, spans two languages, or introduces a new entity *and* port *and*
adapter at once.

**There is no review step between planning and building.** Do not offer or run
`/doc-review` after writing an item. Accepting the plan change *is* the approval —
the next move is `/build`, and it waits for the user to name the item, not for a
second opinion on the wording. `/doc-review` exists for when a plan is explicitly
handed over for review; it is never the automatic next step.

---

## Project Identity

This repo implements **redline**, a **procurement evaluation** adapter for
**Wayfinder**, built as a composable **comprehension lens** so a usable solution
lands sooner. Procurement is the purpose; the lens is the means (decision **D1**,
settled 2026-07-24). Generalising the lens beyond procurement is **not a goal**.

Our own packages live under `@redline/*` in `packages/`. Wayfinder is consumed
read-only under `@rbrasier/*` — the package scope the fork inherits, not a
pointer at rbrasier's repo. Two documents govern:
[`docs/architecture.md`](../docs/architecture.md) is what redline **is**, and
[`docs/delivery-plan.md`](../docs/delivery-plan.md) is what is **left to build**.
[`docs/design-principles.md`](../docs/design-principles.md) holds the durable
adopted principles and non-goals. The delivery plan tracks outstanding work only; it does not restate
design, and its item numbers are local to that file and renumbered whenever the
outstanding set changes.

Both upstream Python engines are **git submodules** consumed for their existing
capabilities, not reimplemented: `services/womblex` (`v0.3.0`) and
`services/numbatch` (`72bcead`). A submodule holds upstream source only — redline's
own code sits beside it (`services/womblex-ingest`, `services/numbatch-extension`).
Run `git submodule update --init` on a fresh clone. Wayfinder is also vendored
from a build-time pin (`wayfinder.pin`, johntooth/wayfinder) because vendoring
the whole package set would drag it into the pnpm workspace.

Publishing target: the **DeepCivic** org (not johntooth).

Run `./validate.sh` to check the workspace. It uses Podman when no local Node is
present (see [`docs/guides/local-dev-and-validation.md`](../docs/guides/local-dev-and-validation.md)).

---

## Architecture Rules (non-negotiable)

Enforced by `validate.sh` and ESLint — skills that write code must respect these:

- `packages/redline-domain` has **zero external dependencies**. Pure TypeScript,
  relative imports only. (Includes no import of `@rbrasier/*`.)
- `packages/redline-application` imports only `@redline/redline-domain` and
  `@redline/redline-shared`. No frameworks, no ORMs, no AI SDKs.
- `packages/redline-adapters` implements ports from `redline-domain`. Drizzle, HTTP
  clients (womblex/Numbatch), object storage, and the read-only reuse of
  Wayfinder's `@rbrasier/domain` typed helpers live here.
- Apps (`apps/*`) import from `@redline/redline-application` and
  `@redline/redline-adapters` only. Wiring lives in `lib/container.ts`.
- All port interfaces use the **Result pattern**: `{ data: T } | { error: DomainError }`.
  Never throw across boundaries.
- Domain entities are plain TypeScript — no decorators, no ORM annotations.
- DB tables use the **`redline_` prefix** in a separate Postgres schema/DB. Columns are
  snake_case. Every table has `id` (uuid), `created_at`, `updated_at`.
- We **never modify Wayfinder's tree**. `vendor/wayfinder` is read-only reuse only,
  and is excluded from lint/format/build/test scope (`--filter=@redline/*`).

---

## Code Writing Rules (non-negotiable)

These apply whenever any skill writes code (inherited verbatim from Wayfinder):

- **Return early** — reduce nesting; never go more than 2 levels deep in a function
- **Descriptive names** — `evaluationRepository` not `evalRepo`, `error` not `err`; no abbreviations
- **No comments explaining WHAT** — only WHY (hidden constraints, workarounds, non-obvious invariants)
- **Result pattern at all boundaries** — never throw across package boundaries
- **Write the test file before the implementation file** — tests are the spec
- **Verify third-party APIs in `node_modules`** — do not rely on training data for exact API shapes; libraries change
- **No dead code** — if something is unused, delete it entirely

---

## Deliberate deviations from Wayfinder

We adopt Wayfinder's quality bar but intentionally differ where the adapter's
reality demands it. These are decisions, not omissions:

| Area | Wayfinder | redline | Why |
|---|---|---|---|
| Planning artefact | PRD + ADR + phase doc per feature | `architecture.md` (design) + `delivery-plan.md` (outstanding **items**, locally numbered). **No ADRs** — decisions are made and recorded in the commit that acts on them | One-repo delivery, sequenced directly in the plan; documents never gate a build |
| Doc lifecycle | `to-be-implemented/` → `implemented/vX/` | A completed item is **removed** from `delivery-plan.md`; its reasoning lives in git history and any durable change lands in `architecture.md`. **No per-item docs** — `docs/threads/` was deleted deliberately | Keeps the plan to outstanding work only |
| Validation | `validate.sh` assuming local Node + services | `validate.sh` detects its runner — local Node when present, **Podman** otherwise; services added per build step | Written for a host with no local Node; both lanes are supported, so check the `runner:` line it prints rather than assuming |
| E2E | Playwright suite exists day one (`/e2e`) | The UI cores + view models are framework-free and unit-tested under `apps/redline-web/`; the Playwright acceptance specs live in the forked Wayfinder (`services/wayfinder/apps/web/e2e/redline-*.spec.ts`) and run against the served `/evaluations` index, `/evaluations/new`, the `/evaluations/:id/{review,pivots,grouping}` routes and `/evaluations/:id/documents/:documentId` | UI logic lives in a pure, testable core; the specs now target the served mount inside the fork — the `/e2e` deviation is closed |
| Release model | alpha branches, `VERSION` sync | Pre-1.0; no alpha branches yet. Version bumps stated per build step | Not yet releasing |
| Scope | `@rbrasier/*` | `@redline/*`, consuming `@rbrasier/*` read-only | This is an adapter, not the framework |

When a deviation stops making sense, add the corresponding Wayfinder
convention and update this table. The Playwright specs now live in the forked
Wayfinder (`services/wayfinder/apps/web/e2e/redline-*.spec.ts`, branch
`redline-integration`) beside Wayfinder's own suite, running against the served
`/evaluations` index, `/evaluations/new`, the
`/evaluations/:id/{grouping,review,pivots}` routes and
`/evaluations/:id/documents/:documentId`.
Every spec that needs a *populated* evaluation gates on
`E2E_REDLINE_EVALUATION_ID` — a real redline evaluation, which lands with the
live corpus run — and skips otherwise, matching the fork's other seed-gated phase
specs. Two specs carry ungated tests, because they render their own empty state:
the index (its sidebar-and-route assertions always run) and create (reaching
`/evaluations/new`, refusing an anonymous caller, and the submit-disabled rules).
Create's *one* live test gates on `E2E_REDLINE_STAGED_CORPUS_ID` instead — it
needs a staged corpus **no evaluation has claimed**, which
`E2E_REDLINE_EVALUATION_ID` by definition does not name. The mount is Next.js/React
inside Wayfinder's own `apps/web`, not a standalone shell and not Numbatch's
unused SvelteKit stack. The vitest suite under `apps/redline-web/` stays the
framework-free proof of the brains + view models the served DOM binds to, and
the fork's own vitest suite proves the binding itself — `review-table.test.tsx`
and `pricing-pivots.test.tsx` mount the `"use client"` components under jsdom
against a fake `trpc` query, so a broken core→DOM bind fails without a browser
or a corpus.

---

## Versioning

Pre-1.0, in active step-by-step development. Each code-writing skill states a
version bump intent (MAJOR / MINOR / PATCH) even though we are not yet cutting
releases, so the history is honest when we do. `validate.sh` will enforce
`VERSION` ↔ `package.json` sync once a `VERSION` file exists.
