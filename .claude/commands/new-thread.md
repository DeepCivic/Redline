# /new-thread — Plan a New Thread or Track

Use this skill when the user wants to plan something new that isn't already a
thread in the build plan: a new thread, a new track, or a substantial component.

**Important:** This skill produces documentation only. Do NOT write code.

---

## Required Clarifying Questions

Ask all of these via `AskUserQuestion` before proceeding:

1. What problem does this solve, and where does it sit in the build plan
   (new thread in an existing track, or a new track)?
2. What are the key entities and ports involved?
3. Does it require DB changes? (All tables use the `redline_` prefix / separate schema.)
4. Does it touch a runtime seam to Wayfinder, womblex, or Numbatch? Which?
5. What is the thread's **exit test** — the single, verifiable acceptance gate?
6. Version bump intent (MAJOR / MINOR / PATCH)?

**After gathering answers:** Output a bulleted summary to the chat covering: the
docs to be generated (thread doc, ADR(s) if needed), the entities/ports, DB
changes and confirmation of the `redline_` prefix, the runtime seams, and the exit
test. Do this as regular chat text — NOT inside `AskUserQuestion`. Then use
`AskUserQuestion` to ask: "Does this look right before I generate the docs?"
Wait for confirmation before starting the workflow.

---

## Workflow

1. Add (or refine) the thread in `docs/procurement-evaluation-plan.md`:
   - Insert it into the right track in §7 with a one-line description **and its
     explicit exit test** (`_Exit: …_`).
   - Add its row to the §10 progress log as ⚪ not started.
2. If architectural decisions are needed, generate ADR(s) in `docs/adr/`
   following the Wayfinder ADR format (see `docs/adr/README.md`).
3. Write a thread spec at `docs/threads/thread-<NN>-<slug>.md`: scope, entities,
   ports, seams, DB changes, sub-component breakdown, and acceptance criteria.

---

## Output

- Updated `docs/procurement-evaluation-plan.md` (§7 entry + §10 row)
- ADR file(s): `docs/adr/<NNNN>-<decision>.adr.md` (if needed)
- Thread spec: `docs/threads/thread-<NN>-<slug>.md`

Do not proceed to `/build` automatically — route the user to `/doc-review` first.
