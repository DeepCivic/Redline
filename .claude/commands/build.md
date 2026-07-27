# /build — Build a Thread

Use this skill when the delivery plan's next thread is ready to implement and the
user confirms, or when the user explicitly asks to implement a specific thread.

**Pre-flight — read before writing anything:**

1. The thread's entry in [`docs/delivery-plan.md`](../../docs/delivery-plan.md)
   — §4 for the current track's scope and exit tests, §5 Build state for status.
2. [`docs/architecture.md`](../../docs/architecture.md) for the seams the thread
   touches. It is the design truth; the plan never restates it.
3. Any ADR(s) either references, in `docs/adr/`.

**Upstream gate — ADR-0015.** If the thread builds anything an upstream engine
might already provide, read that engine's source first: `services/womblex` and
`services/numbatch` are submodules and are on disk (`git submodule update
--init`). This is not optional diligence — redline has already shipped a
duplicate container stack, an import of functions that do not exist, and a schema
mapping against columns upstream never writes, all by integrating against a
dependency nobody had opened.

**ADR gate — before writing any code.** If the thread rests on a decision that is
not yet settled, or needs a new architectural decision:

1. Draft the ADR in `docs/adr/` (`NNNN-<decision>.adr.md`, status **Proposed**).
2. Present it for review and **stop**.
3. Build only once the user approves; flip to **Accepted** in the thread's commit.

Do not build past an unapproved precondition decision.

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
- Before calling any third-party, upstream-engine or Wayfinder API: verify the
  signature in `node_modules/<package>/`, `services/{womblex,numbatch}/`, or
  `vendor/wayfinder/packages/<pkg>/src/` — not training data

**C. Validate**
- Run `./validate.sh` (uses Podman when no local Node — see
  `docs/guides/local-dev-and-validation.md`)
- Fix every failure before moving to the next sub-component
- Do not proceed until `validate.sh` exits 0

### Step 3 — Integration proof (thread-appropriate)

The thread's exit test in the plan is the acceptance gate. Satisfy it explicitly
and paste the passing output:
- Pure package threads → a passing vitest suite exercising the exit criterion.
- Service threads (womblex/Numbatch) → a compose-up + real-request proof.
- UI threads → a Playwright e2e test under `apps/redline-web/e2e/`. These run in
  CI once the Next.js shell serves the routes (Track V, thread 59).

### Step 4 — On completion

- **Update the build state** in `docs/delivery-plan.md` §5: flip the thread's row
  to ✅ with a one-line note carrying the exit-test evidence.
- **Update `docs/architecture.md`** only if the build changed what redline *is* —
  a new seam, a changed contract, a corrected assumption (§7). Routine
  implementation does not touch it.
- **Discovered decisions** — if the build forced an architectural choice that
  could not have been known at planning time, record it as an ADR now, in this
  thread's commit. Precedent: ADR-0002 and ADR-0003 were both locked mid-build.
- There is **no per-thread doc**. `docs/threads/` does not exist and is not to be
  recreated; a package README is the right home for anything longer than a
  build-state note.
- State the version bump intent (MAJOR / MINOR / PATCH).
- Run `./validate.sh` one final time — fix all failures before declaring done.
- **One thread = one commit.** Commit all the thread's changes together.
- **Do NOT open a PR.** A PR is opened only when the user explicitly asks for
  one. Offer it; do not act on the offer unasked.

---

## Scope discipline

A thread is **one build step including its test** (see the thread contract in
`docs/delivery-plan.md` §2). If, mid-build, the thread turns out to be larger:

- Build the part that satisfies the stated exit test, and stop.
- Report what you left out and why, and propose the follow-up thread(s).

Do not widen a thread mid-flight. An overrunning thread is a planning defect to
be fixed in the plan, not absorbed into the current context.
