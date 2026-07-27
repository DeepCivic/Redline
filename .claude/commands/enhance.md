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

1. State the revision in chat — what changes and why, and which thread's exit
   test it affects. Do not code yet, and do not create a thread document:
   `docs/threads/` was deleted deliberately and is not to be recreated.
2. Run `/doc-review` on the revision before building.
3. Once review passes, follow the `/build` workflow exactly:
   - Decompose into sub-components
   - Write tests before implementation for each sub-component
   - Run `./validate.sh` after each sub-component
4. Satisfy the affected thread's exit test again (add a regression test for the
   specific behaviour changed). For UI threads, update/add the Playwright e2e.
5. On completion:
   - Update the thread's row in `docs/delivery-plan.md` §5 noting the revision.
   - Update `docs/architecture.md` only if the revision changed what redline *is*
     — a seam, a contract, a corrected assumption.
   - If a decision changed, add or supersede an ADR in `docs/adr/`.
   - State the version bump intent.
   - Run `./validate.sh` — fix all failures before declaring done.
   - **One revision = one commit.**
   - **Do NOT open a PR.** A PR is opened only when the user explicitly asks for
     one. Offer it; do not act on the offer unasked.
