# /bugfix — Bug Fix

Use this skill when the user reports something broken or not working as expected.

---

## Required Clarifying Questions

Ask all of these via `AskUserQuestion` before proceeding:

1. What's the symptom?
2. How do you reproduce it?
3. Which package, service, or thread is affected?
4. Severity: blocker / major / minor?

**After gathering answers:** Output a bulleted plan to the chat covering the
suspected area of the codebase, files likely involved, and the diagnostic
approach. Do this as regular chat text — NOT inside `AskUserQuestion`. Then use
`AskUserQuestion` to ask: "Does this plan look right?" Wait for confirmation.

---

## Workflow

### Step 1 — Diagnose first, code second

Write a short bug note at `docs/threads/` (or amend the relevant thread doc) with:
- Root cause diagnosis (verified, not assumed)
- Reproduction steps
- Fix plan

Do not write implementation code until the diagnosis is confirmed.

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
For UI bugs (from Thread 11), add a Playwright e2e covering the exact repro.

### Step 6 — On completion

- Record root cause, fix, and regression test in the relevant thread doc.
- Note the fix in the §10 log of `docs/procurement-evaluation-plan.md` if it
  affected a completed thread's exit criteria.
- Apply a PATCH bump intent.
- Run `./validate.sh` one final time.
- Commit; open a PR against the DeepCivic remote's default branch via
  `mcp__github__create_pull_request` when the remote exists.
