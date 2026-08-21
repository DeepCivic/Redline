# CLAUDE.md — Routing Index (redline)

> **A read-only MCP server over Womblex extraction assets.** Its own repo, with
> no submodules. Engineering conventions are inherited from the wider codebase;
> where we deliberately deviate, it is called out under **Deliberate deviations**.

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
`docs/Redline-Status.md` §4 against the build-step contract there — one build
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

This repo implements **redline**: a **read-only MCP server** that serves Womblex's
extraction assets verbatim, so a client LLM can assemble a report grounded
entirely in extracted source. See [`../README.md`](../README.md) for the product
statement and [`docs/Redline-Status.md`](../docs/Redline-Status.md) for what is
built and what is outstanding.

**Separate repos, no nesting.** Womblex extracts and persists; redline serves what
it persisted; the client assembles. Womblex reaches redline through object storage,
redline reaches its client through one MCP endpoint. **There are no git
submodules** — neither neighbour is carried in this tree, and nothing here imports
their source. What redline depends on from Womblex is its output *schema*, recorded
in [`docs/Womblex-Output-Contract.md`](../docs/Womblex-Output-Contract.md).

**The context window shapes the tool surface.** A corpus is hundreds of documents
and no model holds them at once. Redline does navigation (choose what matters, from
metadata alone) and retrieval (exact bytes for one narrow thing, in small pages).
Accumulating findings across documents is the client's — redline is stateless.
A tool that could return a whole corpus is one that will.

**Nothing here generates.** No LLM call, no summarisation, no inference, no report
assembly. A tool returns bytes Womblex wrote, or it returns an error. Anything
that would put model-authored content on redline's side of the boundary is out of
scope by construction, not by omission.

**Nothing here persists.** No database, no run state, no report. redline is
stateless; two identical calls return identical bytes.

Our own packages live under `@redline/*` in `packages/`. One document governs:
[`docs/Redline-Status.md`](../docs/Redline-Status.md) records what is present and
what is outstanding. Outstanding work is tracked in its §4 only; a completed step
is removed from it, its reasoning left in git history, and its item numbers are
local to that section and renumbered whenever the outstanding set changes.

Publishing target: the **DeepCivic** org (not johntooth).

Run `./validate.sh` to check the workspace. It uses Podman when no local Node is
present (see [`docs/guides/local-dev-and-validation.md`](../docs/guides/local-dev-and-validation.md)).

---

## Architecture Rules (non-negotiable)

Enforced by `validate.sh` and ESLint — skills that write code must respect these:

- **Verbatim or nothing.** Every value a tool returns is byte-identical to what
  Womblex wrote. No trimming, no normalisation, no re-encoding, no "helpful"
  reformatting on the way out. Where a value is derived rather than read (for
  example a currency flag inferred from cell text), it is labelled as derived and
  never presented as an extracted column.
- **No generation.** redline holds no LLM client and makes no model call. A change
  that adds one is a change to the product boundary, not an implementation detail.
- **No persistence.** redline owns no database and no mutable state. Reads are
  pure functions of the assets in object storage.
- **Every read is run-scoped.** Multiple Womblex runs co-exist under one corpus
  prefix. A read that spans them serves each document once per run and its
  provenance keys stop identifying anything.
- `packages/redline-domain` has **zero external dependencies**. Pure TypeScript,
  relative imports only. It holds **ports only** — there is no entity above the
  rows a run landed.
- `packages/redline-adapters` implements ports from `redline-domain` — today, the
  womblex-ingest sidecar HTTP client.
- Apps (`apps/*`) import from `@redline/redline-domain` (ports/types) and
  `@redline/redline-adapters` (implementations) only. Wiring lives in
  `lib/container.ts`.
- All port interfaces use the **Result pattern**: `{ data: T } | { error: DomainError }`.
  Never throw across boundaries.
- The Womblex schema is read from
  [`docs/Womblex-Output-Contract.md`](../docs/Womblex-Output-Contract.md), never
  from memory. Column names have been invented before (`elem_order` /
  `col_index` / `is_currency` on table cells) and raised on every real row.

---

## Code Writing Rules (non-negotiable)

These apply whenever any skill writes code:

- **Return early** — reduce nesting; never go more than 2 levels deep in a function
- **Descriptive names** — `stagedCorpusReader` not `corpusRdr`, `error` not `err`; no abbreviations
- **No comments explaining WHAT** — only WHY (hidden constraints, workarounds, non-obvious invariants)
- **Result pattern at all boundaries** — never throw across package boundaries
- **Write the test file before the implementation file** — tests are the spec
- **Verify third-party APIs in `node_modules`** — do not rely on training data for exact API shapes; libraries change
- **No dead code** — if something is unused, delete it entirely

---

## Deliberate deviations

Conventions this repo intentionally does not follow. These are decisions, not
omissions:

| Area | Convention | redline | Why |
|---|---|---|---|
| Planning artefact | PRD + ADR + phase doc per feature | `docs/Redline-Status.md` (what is present + what is outstanding, in §4, locally numbered). **No ADRs** — decisions are made and recorded in the commit that acts on them | One-repo delivery, sequenced directly in the doc; documents never gate a build |
| Doc lifecycle | `to-be-implemented/` → `implemented/vX/` | A completed step is **removed** from `Redline-Status.md` §4 and reflected in its §3; its reasoning lives in git history. **No per-item docs** | Keeps the doc to what is true now plus what is outstanding |
| Validation | `validate.sh` assuming local Node + services | `validate.sh` detects its runner — local Node when present, **Podman** otherwise | Written for a host with no local Node; both lanes are supported, so check the `runner:` line it prints rather than assuming |
| Upstreams | monorepo packages | **Separate repos, no submodules.** Womblex is reached through object storage, the client through the MCP endpoint | A gateway couples to its neighbours' interfaces, not their trees |
| UI | Next.js app in-repo | **None.** redline is headless; every surface belongs to the client that calls it | A stateless read gateway has no UI to own |
| Persistence | Postgres + Drizzle + migrations | **None.** redline stores nothing | Statelessness is the boundary, not a stage it has not reached |
| E2E | Playwright suite exists day one (`/e2e`) | Protocol-level tests against the served MCP endpoint | There is no browser surface here to drive |
| Release model | alpha branches, `VERSION` sync | Pre-1.0; no alpha branches yet. Version bumps stated per build step | Not yet releasing |
| Scope | `@rbrasier/*` | `@redline/*` | This is a standalone server, not a framework |

When a deviation stops making sense, adopt the convention and update this table.

---

## Versioning

Pre-1.0, in active step-by-step development. Each code-writing skill states a
version bump intent (MAJOR / MINOR / PATCH) even though we are not yet cutting
releases, so the history is honest when we do. `validate.sh` will enforce
`VERSION` ↔ `package.json` sync once a `VERSION` file exists.
