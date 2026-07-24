# /new-thread — Plan a New Thread or Track

Use this skill when the user wants to plan something new that isn't already a
thread in the design doc: a new thread, a new track, or a substantial component.

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

## Required Clarifying Questions

Ask via `AskUserQuestion` — but only for what you genuinely cannot derive from
the design doc and the code. Derive the rest and state your assumptions instead.
If the user declines to answer, proceed on stated assumptions rather than
stalling.

1. What problem does this solve, and where does it sit (existing track, or new)?
2. What are the key entities and ports involved?
3. Does it require DB changes? (All tables use the `redline_` prefix / separate schema.)
4. Does it touch a runtime seam to Wayfinder, womblex, or Numbatch? Which?
5. What is the thread's **exit test** — the single, verifiable acceptance gate?
6. Version bump intent (MAJOR / MINOR / PATCH)?

**After gathering answers:** Output a bulleted summary to the chat covering: the
docs to be generated (thread doc, ADR(s) if needed), the entities/ports, DB
changes and confirmation of the `redline_` prefix, the runtime seams, the exit
test, **and the sizing check above**. Do this as regular chat text — NOT inside
`AskUserQuestion`. Then use `AskUserQuestion` to ask: "Does this look right
before I generate the docs?" Wait for confirmation before starting the workflow.

---

## Workflow

1. Add (or refine) the thread in `docs/comprehension-lens-design.md`
   (§6 Delivery — pick the right track: L lens / P procurement / H shell &
   hardening). `docs/procurement-evaluation-plan.md` is **deprecated and frozen**
   — never add threads there:
   - Insert it into the right track in §7 with a one-line description **and its
     explicit exit test** (`_Exit: …_`).
   - Add its row to the §10 progress log as ⚪ not started.
2. If architectural decisions are needed, generate ADR(s) in `docs/adr/`
   following the Wayfinder ADR format (see `docs/adr/README.md`).
3. Write a thread spec at `docs/threads/thread-<NN>-<slug>.md`: scope, entities,
   ports, seams, DB changes, sub-component breakdown, and acceptance criteria.

---

## Output

- Updated `docs/comprehension-lens-design.md` (§6 track entry with its exit test)
- ADR file(s): `docs/adr/<NNNN>-<decision>.adr.md` (if needed)
- Thread spec: `docs/threads/thread-<NN>-<slug>.md`

Do not proceed to `/build` automatically — route the user to `/doc-review` first.
