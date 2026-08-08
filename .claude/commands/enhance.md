# /enhance — Enhancement / Revision

Use this skill when the user wants to change or extend something already built,
rather than implement a not-yet-started item.

---

## Required Clarifying Questions

Ask all of these via `AskUserQuestion` before proceeding:

1. What's changing, and why?
2. Which entities, ports, or use cases are affected?
3. Are DB changes needed? (Confirm `redline_` prefix.)
4. Does it change a runtime seam (Wayfinder / womblex / Numbatch)?
5. Is this a MINOR or PATCH bump? If it's really new scope, stop — plan it as a
   new item in `docs/delivery-plan.md` and route to `/doc-review` instead.

**After gathering answers:** Output a bulleted plan to the chat covering the
likely changes — entities/ports/use-cases touched, files to modify, DB
migrations, seam changes, and the version bump. Do this as regular chat text —
NOT inside `AskUserQuestion`. Then use `AskUserQuestion` to ask: "Does this plan
look right?" Wait for confirmation before starting.

---

## Workflow

1. State the revision in chat — what changes and why, and which exit test it
   affects. Do not code yet, and do not create a per-item document:
   `docs/threads/` was deleted deliberately and is not to be recreated.
2. Run `/doc-review` on the revision before building.
3. Once review passes, follow the `/build` workflow exactly:
   - Decompose into sub-components
   - Write tests before implementation for each sub-component
   - Run `./validate.sh` after each sub-component
4. Satisfy the affected exit test again (add a regression test for the specific
   behaviour changed). For UI work, update/add the Playwright e2e.
5. On completion:
   - Update `docs/delivery-plan.md` only if the revision changed the outstanding
     set (a re-opened item, a new follow-up). A finished revision leaves no
     status row — the plan tracks outstanding work only.
   - Update `docs/architecture.md` only if the revision changed what redline *is*
     — a seam, a contract, a corrected assumption.
   - If a decision changed, say so in the commit message. Do not create a
     document for it.
   - State the version bump intent.
   - Run `./validate.sh` — fix all failures before declaring done.
   - **One revision = one commit.**
   - **Do NOT open a PR.** A PR is opened only when the user explicitly asks for
     one. Offer it; do not act on the offer unasked.
