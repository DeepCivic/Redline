# /bugfix — Bug Fix

Use this skill when the user reports something broken or not working as expected.

---

## Required Clarifying Questions

Ask all of these via `AskUserQuestion` before proceeding:

1. What's the symptom?
2. How do you reproduce it?
3. Which package, service, or item is affected?
4. Severity: blocker / major / minor?

**After gathering answers:** Output a bulleted plan to the chat covering the
suspected area of the codebase, files likely involved, and the diagnostic
approach. Do this as regular chat text — NOT inside `AskUserQuestion`. Then use
`AskUserQuestion` to ask: "Does this plan look right?" Wait for confirmation.

---

## Workflow

### Step 1 — Diagnose first, code second

State in chat:
- Root cause diagnosis (**verified, not assumed** — read the code, and if the bug
  is at a seam, read the upstream submodule under `services/`; several redline
  bugs have been bindings written against symbols and columns that upstream never
  had)
- Reproduction steps
- Fix plan

Do not write implementation code until the diagnosis is confirmed, and do not
create a bug document — `docs/threads/` was deleted deliberately.

### Step 2 — Write a failing test

Write a test that reproduces the bug and currently fails. This becomes the
regression guard.

### Step 3 — Fix

Implement the minimal change that makes the failing test pass without breaking
existing tests. Do not refactor unrelated code in the same commit.

### Step 4 — Validate

Run `./validate.sh` (Podman-backed when no local Node) and fix all failures.

### Step 5 — Regression proof

Confirm the test from Step 2 fails on the unfixed code and passes after the fix.
For UI bugs, add a Playwright e2e covering the exact repro.

### Step 6 — On completion

- Record root cause, fix and regression test in the commit message.
- Update the affected item's entry in `docs/delivery-plan.md` only if the bug
  re-opened outstanding work (e.g. an item thought finished must return to §2).
  A fix to already-shipped code leaves no status row — the plan tracks
  outstanding work only.
- If the bug was a wrong assumption about a seam, correct
  `docs/architecture.md` §7 so it is not re-derived.
- Apply a PATCH bump intent.
- Run `./validate.sh` one final time.
- Commit.
- **Do NOT open a PR.** A PR is opened only when the user explicitly asks for
  one. Offer it; do not act on the offer unasked.
