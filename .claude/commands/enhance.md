# /enhance — Enhancement / Revision

Use this skill when the user wants to change or extend something already built
(a completed thread), rather than implement a not-yet-started thread.

---

## Required Clarifying Questions

Ask all of these via `AskUserQuestion` before proceeding:

1. What's changing, and why?
2. Which entities, ports, or use cases are affected? Which thread(s) do they belong to?
3. Are DB changes needed? (Confirm `redline_` prefix.)
4. Does it change a runtime seam (Wayfinder / womblex / Numbatch)?
5. Is this a MINOR or PATCH bump? If it's really new scope, stop and route to
   `/new-thread` instead.

**After gathering answers:** Output a bulleted plan to the chat covering the
likely changes — entities/ports/use-cases touched, files to modify, DB
migrations, seam changes, and the version bump. Do this as regular chat text —
NOT inside `AskUserQuestion`. Then use `AskUserQuestion` to ask: "Does this plan
look right?" Wait for confirmation before starting.

---

## Workflow

1. Write a short revision note at `docs/threads/thread-<NN>-<slug>.md` (or amend
   the existing thread doc) describing what changes and why — do not code yet.
2. Run `/doc-review` on the revision before building.
3. Once review passes, follow the `/build` workflow exactly:
   - Decompose into sub-components
   - Write tests before implementation for each sub-component
   - Run `./validate.sh` after each sub-component
4. Satisfy the affected thread's exit test again (add a regression test for the
   specific behaviour changed). For UI threads, update/add the Playwright e2e.
5. On completion:
   - Refresh the thread doc and, if a decision changed, add/supersede an ADR.
   - Update `docs/procurement-evaluation-plan.md` (§10 log entry noting the revision).
   - State the version bump intent.
   - Run `./validate.sh`.
   - Commit; open a PR against the DeepCivic remote's default branch via
     `mcp__github__create_pull_request` when the remote exists.
