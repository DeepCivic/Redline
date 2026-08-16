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
`docs/delivery-plan.md` (§2/§3) against the build-step contract in §1 — one build
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
the chunks, graph, money-spans and extraction JSON that run lands serve two
consumers: the fork's Create Corpus UI and `apps/redline-mcp`'s report tools.

**Nothing here models a judgement over a corpus.** The Evaluation aggregate and
the comprehension lens were removed on 2026-08-15; interpreting what a run landed
belongs to a consumer, above the store. See `docs/design-principles.md` §2 — a
re-entry is a new design, not a restoration.

Our own packages live under `@redline/*` in `packages/`. Wayfinder is consumed
read-only under `@rbrasier/*` — the package scope the fork inherits, not a
pointer at rbrasier's repo. Two documents govern:
[`docs/architecture.md`](../docs/architecture.md) is what redline **is**, and
[`docs/delivery-plan.md`](../docs/delivery-plan.md) is what is **left to build**.
[`docs/design-principles.md`](../docs/design-principles.md) holds the durable
adopted principles and non-goals. The delivery plan tracks outstanding work only; it does not restate
design, and its item numbers are local to that file and renumbered whenever the
outstanding set changes.

Both upstreams are **git submodules** consumed for their existing capabilities,
not reimplemented: `services/womblex` and the Wayfinder fork `services/wayfinder`
(johntooth/wayfinder, branch `main`). A submodule holds upstream source only —
redline's own code sits beside it (`services/womblex-ingest`). Run
`git submodule update --init` on a fresh clone.

**The gitlink is the only pin.** Each submodule tracks its upstream's latest
`main`, and no SHA or version is restated anywhere else — bumping one is one
edit. Wayfinder's `@rbrasier/domain` is copied out of `services/wayfinder` into
`vendor/wayfinder` at build time (`scripts/vendor-wayfinder.sh`) because the pnpm
workspace glob would otherwise absorb the fork's whole package set; that copy is
a filter on what is vendored, not a second pin.

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
- DB tables use the **`redline_` prefix** in a separate Postgres schema/DB. Columns
  are snake_case. The four surviving tables mirror what the womblex sidecar's load
  path writes, so they follow **its** DDL rather than the id/created_at/updated_at
  convention — the schema is the sidecar's wire contract, not redline's choice.
- Migrations are **forward-only**. Every file is `IF NOT EXISTS`-guarded and
  re-applied on every boot, so a landed migration is never edited or deleted —
  correcting one means adding another.
- We **never modify Wayfinder's tree**. `vendor/wayfinder` is read-only reuse only,
  and is excluded from lint/format/build/test scope (`--filter=@redline/*`).

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
| Planning artefact | PRD + ADR + phase doc per feature | `architecture.md` (design) + `delivery-plan.md` (outstanding **items**, locally numbered). **No ADRs** — decisions are made and recorded in the commit that acts on them | One-repo delivery, sequenced directly in the plan; documents never gate a build |
| Doc lifecycle | `to-be-implemented/` → `implemented/vX/` | A completed item is **removed** from `delivery-plan.md`; its reasoning lives in git history and any durable change lands in `architecture.md`. **No per-item docs** — `docs/threads/` was deleted deliberately | Keeps the plan to outstanding work only |
| Validation | `validate.sh` assuming local Node + services | `validate.sh` detects its runner — local Node when present, **Podman** otherwise; services added per build step | Written for a host with no local Node; both lanes are supported, so check the `runner:` line it prints rather than assuming |
| E2E | Playwright suite exists day one (`/e2e`) | The UI cores + view models are framework-free and unit-tested under `apps/redline-web/`; the Playwright acceptance spec lives in the forked Wayfinder (`services/wayfinder/apps/web/e2e/redline-create-corpus.spec.ts`) and runs against the served `/create-corpus` route | UI logic lives in a pure, testable core; the spec targets the served mount inside the fork — the `/e2e` deviation is closed |
| Release model | alpha branches, `VERSION` sync | Pre-1.0; no alpha branches yet. Version bumps stated per build step | Not yet releasing |
| Scope | `@rbrasier/*` | `@redline/*`, consuming `@rbrasier/*` read-only | This is a plugin, not the framework |

When a deviation stops making sense, add the corresponding Wayfinder
convention and update this table. The Playwright spec now lives in the forked
Wayfinder (`services/wayfinder/apps/web/e2e/redline-create-corpus.spec.ts`, branch
`main` — the branch `.gitmodules` names) beside Wayfinder's own suite, running
against the served `/create-corpus` route.

The spec splits on what a test needs rather than switching halves off. The tab,
its permission gate, the readiness rule, the upload list and the override editors
are client-side and always run. Firing a real run gates on
`E2E_REDLINE_RUN_STACK` — a reachable womblex-ingest sidecar and object storage —
because the surface stages its own documents rather than reusing a pre-staged
corpus. That live half splits again on `E2E_REDLINE_ISAACUS`, which is a question
about **cost**, not infrastructure: a run over the offline stages (extraction plus
`money`) drives the whole browser → object store → engine → tracker path for
nothing and needs no key, while `chunk` / `embed` / `enrich` are Isaacus spend.
Unset, the run must fail naming `chunk` and offer its resume; set, the run must
drain with `chunk` completed and report the corpus readable.

The mount is Next.js/React inside Wayfinder's own `apps/web`, not a standalone
shell. The vitest suite under `apps/redline-web/` stays the framework-free proof
of the brains + view models the served DOM binds to, and the fork's own vitest
suite proves the binding itself, so a broken core→DOM bind fails without a browser
or a corpus.

---

## Versioning

Pre-1.0, in active step-by-step development. Each code-writing skill states a
version bump intent (MAJOR / MINOR / PATCH) even though we are not yet cutting
releases, so the history is honest when we do. `validate.sh` will enforce
`VERSION` ↔ `package.json` sync once a `VERSION` file exists.
