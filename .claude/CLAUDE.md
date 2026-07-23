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
| Plan a new thread/track, design something, start a component     | `/new-thread`  |
| Review a thread spec or the build plan before building           | `/doc-review`  |
| Implement a thread from the build plan, write code               | `/build`       |
| Change or extend something already built                         | `/enhance`     |
| Fix something broken or not working                              | `/bugfix`      |
| Anything else                                                    | Answer directly |

---

## Project Identity

This repo implements **redline**, a procurement-evaluation adapter for
**Wayfinder**. Our own packages live under `@redline/*` in `packages/`.
Wayfinder is consumed read-only under `@rbrasier/*` (see ADR-0001). The living
delivery plan is [`docs/procurement-evaluation-plan.md`](../docs/procurement-evaluation-plan.md);
each thread there links to its own technical doc/README on completion.

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
| Planning artefact | PRD + ADR + phase doc per feature | Single **build plan** with numbered **threads**; ADRs as needed | One-repo delivery already sequenced into threads (§7 of the plan) |
| Doc lifecycle | `to-be-implemented/` → `implemented/vX/` | Thread rows in the build plan flip to ✅ and link to a thread doc/README | Keeps the whole delivery legible in one file |
| Validation | `validate.sh` assuming local Node + services | `validate.sh` runs via **Podman** when no local Node; services added per-thread | Host here has no local Node |
| E2E | Playwright suite exists day one (`/e2e`) | Deferred until `apps/redline-web` (Thread 11) | No UI yet; adding `/e2e` when the app lands |
| Release model | alpha branches, `VERSION` sync | Pre-1.0; no alpha branches yet. Version bumps tracked per thread | Not yet releasing |
| Scope | `@rbrasier/*` | `@redline/*`, consuming `@rbrasier/*` read-only | This is an adapter, not the framework |

When a deviation stops making sense (e.g. Thread 11 adds a UI), add the
corresponding Wayfinder convention (a `/e2e` skill) and update this table.

---

## Versioning

Pre-1.0, in active thread-by-thread development. Each code-writing skill states a
version bump intent (MAJOR / MINOR / PATCH) even though we are not yet cutting
releases, so the history is honest when we do. `validate.sh` will enforce
`VERSION` ↔ `package.json` sync once a `VERSION` file exists.
