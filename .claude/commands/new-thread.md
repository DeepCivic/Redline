# /new-thread — Plan a New Thread or Track

Use this skill when the user wants to plan something new that isn't already a
thread in [`docs/delivery-plan.md`](../../docs/delivery-plan.md): a new thread, a
new track, or a substantial component.

**Important:** This skill produces documentation only. Do NOT write code.

---

## The thread contract (apply before anything else)

A **thread is one build step**, sized to fit a single agent's context. This is
the guard against token bloat spanning build tasks.

- **One build step, including its test.** If the exit test needs two unrelated
  things built first, it is two threads.
- **One agent, one context.** Completable without re-reading half the repo.
- **One commit.** A PR is opened **only on explicit user request**.
- **One package where possible.** Crossing a package boundary needs a reason;
  crossing three means it is three threads.
- **Tests-first** — the test file precedes the implementation file.

**Sizing test — split the thread if any of these is true:**

- The exit test has an "and" joining two independently-testable behaviours.
- It spans two languages (TS + Python) — that is a seam, so it is two threads,
  one per side, each with its own test.
- It introduces a new entity *and* a new port *and* an adapter.
- You cannot state the exit test in one sentence without a semicolon.

When in doubt, split. Two small threads cost less than one that overruns its
context.

---

## Before planning: check upstream first (ADR-0015)

If the thread would build a capability an upstream engine may already provide,
read that engine's source before writing the thread — `services/womblex` and
`services/numbatch` are submodules on disk. redline has already built a
duplicate container stack, orchestration and object-storage staging that womblex
shipped. A thread that reimplements an upstream capability is a planning defect,
and this is where it is cheapest to catch.

---

## Required Clarifying Questions

Ask via `AskUserQuestion` — but only for what you genuinely cannot derive from
the plan, `architecture.md`, and the code. Derive the rest and state your
assumptions instead. If the user declines to answer, proceed on stated
assumptions rather than stalling.

1. What problem does this solve, and where does it sit (existing track, or new)?
2. What are the key entities and ports involved?
3. Does it require DB changes? (All tables use the `redline_` prefix / separate schema.)
4. Does it touch a runtime seam to Wayfinder, womblex, or Numbatch? Which?
5. What is the thread's **exit test** — the single, verifiable acceptance gate?
6. Version bump intent (MAJOR / MINOR / PATCH)?

**After gathering answers:** Output a bulleted summary to the chat covering: the
entities/ports, DB changes and confirmation of the `redline_` prefix, the runtime
seams, any ADR needed, the exit test, **and the sizing check above**. Do this as
regular chat text — NOT inside `AskUserQuestion`. Then use `AskUserQuestion` to
ask: "Does this look right before I update the plan?" Wait for confirmation.

---

## Workflow

1. Add (or refine) the thread in `docs/delivery-plan.md`:
   - Put it in the right track — **V** (the lean vertical, current priority),
     **L** (comprehension lens, deferred), **H** (infra/shell/release).
   - Give it a one-line description **and an explicit exit test** (`_Exit: …_`).
   - Add its row to the §5 Build state table as ⚪ not started, continuing the
     monotonic numbering so a number never collides with a historical reference.
2. If the thread rests on an architectural decision that is not already settled,
   draft the ADR in `docs/adr/` at status **Proposed**, following the format in
   `docs/adr/README.md`. The ADR is a **precondition** — drafted here, reviewed
   via `/doc-review`, approved before `/build` writes code. Do not pre-write ADRs
   for decisions the build will discover; those are recorded retrospectively.
3. If the thread changes what redline *is* — a new seam, a changed contract —
   note the intended change to `docs/architecture.md`. Do not edit it
   speculatively; `/build` updates it when the change is real.

There is **no per-thread spec document.** `docs/threads/` was deleted
deliberately and is not to be recreated: the thread's row plus its exit test is
the spec, and anything longer belongs in a package README or an ADR.

---

## Output

- Updated `docs/delivery-plan.md` (track entry with its exit test, plus a
  Build state row)
- ADR file(s): `docs/adr/<NNNN>-<decision>.adr.md` (if needed)

Do not proceed to `/build` automatically — route the user to `/doc-review` first.
