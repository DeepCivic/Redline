# /build — Build an Outstanding Item

Use this skill when the delivery plan's next outstanding item is ready to
implement and the user confirms, or when the user explicitly asks to implement a
specific item.

**Pre-flight — read before writing anything:**

1. The item's entry in [`docs/delivery-plan.md`](../../docs/delivery-plan.md)
   — §2 for the lean vertical's outstanding items and their exit tests, §3 for
   the deferred set, §5 for sequencing.
2. [`docs/architecture.md`](../../docs/architecture.md) for the seams the item
   touches. It is the design truth; the plan never restates it.
3. Any ADR(s) either references, in `docs/adr/`.

**Upstream gate — ADR-0015.** If the item builds anything an upstream engine
might already provide, read that engine's source first: `services/womblex` and
`services/numbatch` are submodules and are on disk (`git submodule update
--init`). This is not optional diligence — redline has already shipped a
duplicate container stack, an import of functions that do not exist, and a schema
mapping against columns upstream never writes, all by integrating against a
dependency nobody had opened.

**ADR gate — before writing any code.** If the item rests on a decision that is
not yet settled, or needs a new architectural decision:

1. Draft the ADR in `docs/adr/` (`NNNN-<decision>.adr.md`).
2. Present it for review and **stop**.
3. Build only once the user has settled it.

Do not build past a precondition decision that is still open.

**ADRs carry no status field.** Review happens on the PR that contains the ADR;
merged is decided, unmerged is not. Do not add one, and do not "flip" anything.
What an ADR *does* record is its relationships to
other ADRs — what it amends, narrows or overturns, and what of an earlier
decision survives — because that is the decision's content, not its workflow.

Confirm the item's **exit test** before writing a line of code. Read the
relevant `@rbrasier/*` source in `vendor/wayfinder/packages/*` for any Wayfinder
helper you intend to reuse — do not trust training data for its shape.

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
- Before calling any third-party, upstream-engine or Wayfinder API: verify the
  signature in `node_modules/<package>/`, `services/{womblex,numbatch}/`, or
  `vendor/wayfinder/packages/<pkg>/src/` — not training data

**C. Validate**
- Run `./validate.sh` (uses Podman when no local Node — see
  `docs/guides/local-dev-and-validation.md`)
- Fix every failure before moving to the next sub-component
- Do not proceed until `validate.sh` exits 0

### Step 3 — Integration proof (item-appropriate)

The item's exit test in the plan is the acceptance gate. Satisfy it explicitly
and paste the passing output:
- Pure package items → a passing vitest suite exercising the exit criterion.
- Service items (womblex/Numbatch) → a compose-up + real-request proof.
- UI items → a Playwright e2e test in the fork, under
  `services/wayfinder/apps/web/e2e/redline-*.spec.ts`, beside Wayfinder's own
  suite and running against the served routes. There is no `apps/redline-web/e2e/`
  — the pure cores and view models are proven by the vitest suite there instead.

### Step 4 — On completion

- **Remove the completed item** from `docs/delivery-plan.md` §2 (or §3): the plan
  tracks outstanding work only, so a finished item is deleted, not flipped to a
  status. Its reasoning lives in the commit and in git history. Renumber the
  remaining items if the outstanding set changed — the numbers are local and
  carry no history.
- **Update `docs/architecture.md`** only if the build changed what redline *is* —
  a new seam, a changed contract, a corrected assumption (§7). Routine
  implementation does not touch it.
- **Discovered decisions** — if the build forced an architectural choice that
  could not have been known at planning time, record it as an ADR now, in this
  item's commit. Precedent: ADR-0002 and ADR-0003 were both locked mid-build.
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
`docs/delivery-plan.md` §1). If, mid-build, the item turns out to be larger:

- Build the part that satisfies the stated exit test, and stop.
- Report what you left out and why, and propose the follow-up item(s).

Do not widen an item mid-flight. An overrunning build step is a planning defect to
be fixed in the plan, not absorbed into the current context.
