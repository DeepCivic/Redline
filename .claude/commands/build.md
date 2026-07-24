# /build — Build a Thread from the Design Doc

Use this skill when the design doc's next thread is ready to implement and the
user confirms, or when the user explicitly asks to implement a specific thread.

**Pre-flight:** Read the target thread in
[`docs/comprehension-lens-design.md`](../../docs/comprehension-lens-design.md)
(§6 Delivery for scope + exit test, §10 Build state for status)
in full, plus any ADR(s) it references and any thread doc under `docs/threads/`.
Check §7's decision register first — threads in Track L may rest on decisions
(D1/D2/D3) still marked **assumed**; if the thread depends on one, confirm it
with the user before building.
Confirm the thread's **exit test** before writing a line of code. Read the
relevant `@rbrasier/*` source in `vendor/wayfinder/packages/*` for any Wayfinder
helper you intend to reuse — do not trust training data for its shape.

---

## Workflow

### Step 1 — Decompose

Break the thread into sub-components of no more than 3–4 files each. List them in
chat before starting so the user can see the plan.

### Step 2 — For each sub-component (strictly in order)

**A. Write tests first**
- Create `*.test.ts` before the implementation file
- Cover: happy path, error path (`DomainError`), key edge cases
- Use in-memory fakes for ports — never mock what you own
- Tests must read as plain English: setup → execute → verify
- Prefer a few duplicated setup lines over a shared abstraction that obscures intent

**B. Implement**
- Make the tests pass with the minimum code required
- Follow all architecture and code writing rules from `.claude/CLAUDE.md`
- Before calling any third-party or Wayfinder API: verify the signature in
  `node_modules/<package>/` or `vendor/wayfinder/packages/<pkg>/src/` — not training data

**C. Validate**
- Run `./validate.sh` (uses Podman when no local Node — see
  `docs/guides/local-dev-and-validation.md`)
- Fix every failure before moving to the next sub-component
- Do not proceed until `validate.sh` exits 0

### Step 3 — Integration proof (thread-appropriate)

Every thread's exit test in the build plan is the acceptance gate. Satisfy it
explicitly and paste the passing output:
- Pure package threads → a passing vitest suite exercising the exit criterion.
- Service threads (womblex/Numbatch) → a compose-up + real-request proof.
- UI threads (from Thread 11) → a Playwright e2e test under `apps/redline-web/e2e/`.
  (Add the `/e2e` skill at that point — see the deviations table in `CLAUDE.md`.)

### Step 4 — On completion

- Write/refresh the thread's technical doc at
  `docs/threads/thread-<NN>-<slug>.md` (or a package README) covering: what was
  built, files created/modified, migrations, the exit-test evidence, known
  limitations, and any decision that should become an ADR.
- If the thread made an architectural decision, add an ADR in `docs/adr/`
  (`NNNN-<decision>.adr.md`) and update the matching row in §7 of the design doc's
  decision register (flipping an **assumed** decision to settled).
- **Update the design doc** (`docs/comprehension-lens-design.md`):
  - Flip the thread's row in §10 Build state to ✅ with a one-line note.
  - Append the thread doc link to the thread's §6 entry, in the form
    `— docs: [thread-<NN>](./threads/thread-<NN>-<slug>.md)`.
  - Never write to `docs/procurement-evaluation-plan.md` — deprecated and frozen.
- State the version bump intent (MAJOR / MINOR / PATCH).
- Run `./validate.sh` one final time — fix all failures before declaring done.
- **One thread = one commit.** Commit all the thread's changes together.
- **Do NOT open a PR.** A PR is opened only when the user explicitly asks for
  one. Offer it; do not act on the offer unasked.

---

## Scope discipline

A thread is **one build step including its test** (see the thread contract in
`/new-thread`). If, mid-build, the thread turns out to be larger than that:

- Build the part that satisfies the stated exit test, and stop.
- Report what you left out and why, and propose the follow-up thread(s).

Do not widen a thread mid-flight. An overrunning thread is a planning defect to
be fixed in the design doc, not absorbed into the current context.
