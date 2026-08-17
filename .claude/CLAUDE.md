# CLAUDE.md — Routing Index (redline)

> **Corpus-ingest-and-report substrate.** A Wayfinder plugin in its own repo. This
> file adapts Wayfinder's engineering conventions; where we deliberately deviate,
> it is called out explicitly under **Deliberate deviations from Wayfinder**.

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
| Plan a new build step or component (add/refine an item in the plan) | Answer directly, then `/doc-review` |
| Review a planned build step before building it                   | `/doc-review`  |
| Implement an outstanding item from the delivery plan, write code | `/build`       |
| Change or extend something already built                         | `/enhance`     |
| Fix something broken or not working                              | `/bugfix`      |
| Anything else                                                    | Answer directly |

Planning new work is not its own skill: add or refine the item directly in
`docs/Redline-Plan.md` §9 against the build-step contract there — one build
step including its test, one commit, one package where possible, an explicit
`_Exit: …_` test — then route to `/doc-review`. Split the item if its exit test
joins two independently-testable behaviours, spans two languages, or introduces a
new entity *and* port *and* adapter at once.

**The review step between planning and building stays.** It has paid for itself:
the 2026-08-09 scope decisions reached `/doc-review` carrying two false claims —
a descope record implying a staging runbook the plan says does not exist, and an
assertion that nothing served calls the run use cases — and both were corrected
rather than shipped. Wording is not what it catches; claims are.

---

## Project Identity

This repo implements **redline**, a **corpus-ingest-and-report substrate** for
**Wayfinder**. A specialist stages a corpus, the womblex engine processes it, and
a per-document report extraction engine reads the chunks, graph and money spans
that run lands to fill in user-defined report columns — see
[`docs/Redline-Plan.md`](../docs/Redline-Plan.md) for the product statement.

**Nothing here models a judgement over a corpus.** The Evaluation aggregate and
the comprehension lens were removed on 2026-08-15; interpreting what a run landed
belongs to a consumer, above the store — the report engine reads rows, it does
not decide what they mean beyond the constraint rules the plan states.

Our own packages live under `@redline/*` in `packages/`. Wayfinder is consumed
read-only under `@rbrasier/*` — the package scope the fork inherits, not a
pointer at rbrasier's repo. One document governs:
[`docs/Redline-Plan.md`](../docs/Redline-Plan.md) is both the product statement
(what redline delivers) and the delivery detail (data model, architecture, build
steps §9 and their exit tests) — it superseded the former `architecture.md` /
`delivery-plan.md` / `design-principles.md` split on 2026-08-17. Outstanding
build steps are tracked in §9 only; a completed step is removed from it, its
reasoning left in git history, and its item numbers are local to that section
and renumbered whenever the outstanding set changes.

Both upstreams are **git submodules** consumed for their existing capabilities,
not reimplemented: `services/womblex` and the Wayfinder fork `services/wayfinder`
(johntooth/wayfinder, branch `main`). A submodule holds upstream source only —
redline's own code sits beside it (`services/womblex-ingest`). Run
`git submodule update --init` on a fresh clone.

**The gitlink is the only pin.** Each submodule tracks its upstream's latest
`main`, and no SHA or version is restated anywhere else — bumping one is one
edit.

Publishing target: the **DeepCivic** org (not johntooth).

Run `./validate.sh` to check the workspace. It uses Podman when no local Node is
present (see [`docs/guides/local-dev-and-validation.md`](../docs/guides/local-dev-and-validation.md)).

---

## Architecture Rules (non-negotiable)

Enforced by `validate.sh` and ESLint — skills that write code must respect these:

- `packages/redline-domain` has **zero external dependencies**. Pure TypeScript,
  relative imports only. (Includes no import of `@rbrasier/*`.) It holds **ports
  only** — there is no entity above the rows a run lands.
- `packages/redline-adapters` implements ports from `redline-domain`. Drizzle, the
  womblex sidecar HTTP client, object storage, and the read-only reuse of
  Wayfinder's `@rbrasier/domain` typed helpers live here.
- Apps (`apps/*`) import from `@redline/redline-domain` (ports/types) and
  `@redline/redline-adapters` (implementations) only. Wiring lives in
  `lib/container.ts`.
- All port interfaces use the **Result pattern**: `{ data: T } | { error: DomainError }`.
  Never throw across boundaries.
- DB tables use the **`redline_` prefix** in a separate Postgres schema/DB, columns
  snake_case. There is no schema today — redline's Postgres was removed with the
  Evaluation surface; the report domain (definitions/runs/rows/values) re-owns it
  at build step 2 (`docs/Redline-Plan.md` §9).
- Migrations are **forward-only**, and every file is `IF NOT EXISTS`-guarded and
  re-applied *in full on every boot*. So correcting a migration's **effect** means
  adding another file, never rewriting history.
- We **never modify Wayfinder's tree** (`services/wayfinder`) — it is read-only
  reuse and excluded from lint/format/build/test scope (`--filter=@redline/*`).

---

## Code Writing Rules (non-negotiable)

These apply whenever any skill writes code (inherited verbatim from Wayfinder):

- **Return early** — reduce nesting; never go more than 2 levels deep in a function
- **Descriptive names** — `stagedCorpusReader` not `corpusRdr`, `error` not `err`; no abbreviations
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
| Planning artefact | PRD + ADR + phase doc per feature | `docs/Redline-Plan.md` (product statement + delivery detail, outstanding build steps in §9, locally numbered). **No ADRs** — decisions are made and recorded in the commit that acts on them | One-repo delivery, sequenced directly in the plan; documents never gate a build |
| Doc lifecycle | `to-be-implemented/` → `implemented/vX/` | A completed step is **removed** from `Redline-Plan.md` §9; its reasoning lives in git history and any durable change lands in the plan's design sections. **No per-item docs** — `docs/threads/` was deleted deliberately | Keeps the plan to outstanding work only |
| Validation | `validate.sh` assuming local Node + services | `validate.sh` detects its runner — local Node when present, **Podman** otherwise; services added per build step | Written for a host with no local Node; both lanes are supported, so check the `runner:` line it prints rather than assuming |
| E2E | Playwright suite exists day one (`/e2e`) | The UI cores + view models are framework-free and unit-tested in-repo; the Playwright acceptance spec lives in the forked Wayfinder (`services/wayfinder/apps/web/e2e/`) beside Wayfinder's own suite, running against the served route the fork surface mounts | UI logic lives in a pure, testable core; the spec targets the served mount inside the fork |
| Release model | alpha branches, `VERSION` sync | Pre-1.0; no alpha branches yet. Version bumps stated per build step | Not yet releasing |
| Scope | `@rbrasier/*` | `@redline/*`, consuming `@rbrasier/*` read-only | This is a plugin, not the framework |

When a deviation stops making sense, add the corresponding Wayfinder
convention and update this table.

The fork surface (column editor, document picker, run + progress, read-only
sample table, export) is unlanded — see `docs/Redline-Plan.md` §8 blocker 3 and
§9 step 10. Its Playwright spec is written and reviewed alongside that step,
not assumed here in advance.

---

## Versioning

Pre-1.0, in active step-by-step development. Each code-writing skill states a
version bump intent (MAJOR / MINOR / PATCH) even though we are not yet cutting
releases, so the history is honest when we do. `validate.sh` will enforce
`VERSION` ↔ `package.json` sync once a `VERSION` file exists.
