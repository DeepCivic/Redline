# /build — Build an Outstanding Item

Use this skill when the plan's next outstanding build step is ready to
implement and the user confirms, or when the user explicitly asks to implement a
specific item.

**Pre-flight — read before writing anything:**

1. The item's entry in [`docs/Redline-Plan.md`](../../docs/Redline-Plan.md) §9
   for outstanding build steps and their exit tests, §0/§8 for status and known
   blockers.
2. The rest of `docs/Redline-Plan.md` (data model §2, architecture §3, the
   extraction call contract §4) for the seams the item touches. It is the
   design truth; §9 never restates it.

**Upstream gate.** If the item builds anything an upstream engine
might already provide, read that engine's source first: `services/womblex` is a
submodule and is on disk (`git submodule update --init`). This is not optional
diligence — redline has already shipped a duplicate container stack, an import
of functions that do not exist, and a schema mapping against columns upstream
never writes, all by integrating against a dependency nobody had opened.

**Do not stop to write a decision record.** If a choice needs making, make it,
say so in the commit, and keep building. Nothing in this repo gates a build on a
document.

Confirm the item's **exit test** before writing a line of code.

---

## Workflow

### Step 1 — Decompose

Break the item into sub-components of no more than 3–4 files each. List them in
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
- Before calling any third-party or upstream-engine API: verify the signature
  in `node_modules/<package>/` or `services/womblex/` — not training data

**C. Validate**
- Run `./validate.sh` (uses Podman when no local Node — see
  `docs/guides/local-dev-and-validation.md`)
- Fix every failure before moving to the next sub-component
- Do not proceed until `validate.sh` exits 0

### Step 3 — Integration proof (item-appropriate)

The item's exit test in the plan is the acceptance gate. Satisfy it explicitly
and paste the passing output:
- Pure package items → a passing vitest suite exercising the exit criterion.
- Service items (the sidecar, womblex) → a compose-up + real-request proof.
- UI items → a Playwright e2e test in the fork, under
  `services/wayfinder/apps/web/e2e/redline-*.spec.ts`, beside Wayfinder's own
  suite and running against the served routes.

### Step 4 — On completion

- **Remove the completed step** from `docs/Redline-Plan.md` §9: the plan
  tracks outstanding work only, so a finished step is deleted, not flipped to a
  status. Its reasoning lives in the commit and in git history. Renumber the
  remaining steps if the outstanding set changed — the numbers are local and
  carry no history.
- **Update the plan's design sections** (§1-§8) only if the build changed what
  redline *is* — a new seam, a changed contract, a corrected assumption.
  Routine implementation does not touch them.
- **Discovered decisions** go in the commit message. Do not create a document
  for them.
- There is **no per-item doc**. `docs/threads/` does not exist and is not to be
  recreated; a package README is the right home for anything longer than a
  commit-message note.
- State the version bump intent (MAJOR / MINOR / PATCH).
- Run `./validate.sh` one final time — fix all failures before declaring done.
- **One build step = one commit.** Commit all the item's changes together.
- **Do NOT open a PR.** A PR is opened only when the user explicitly asks for
  one. Offer it; do not act on the offer unasked.

---

## Scope discipline

An item is **one build step including its test** (see the build-step contract in
`docs/Redline-Plan.md` §9's header). If, mid-build, the item turns out to be larger:

- Build the part that satisfies the stated exit test, and stop.
- Report what you left out and why, and propose the follow-up item(s).

Do not widen an item mid-flight. An overrunning build step is a planning defect to
be fixed in the plan, not absorbed into the current context.
