# ADR-0012 — Wayfinder is pinned by commit and optional at install time

- **Status**: Accepted
- **Date**: 2026-07-25
- **Amends**: [ADR-0001](./0001-adapter-over-wayfinder.adr.md) (Strategy A's mechanics and Enforcement clause)

## Context

[ADR-0001](./0001-adapter-over-wayfinder.adr.md) chose Strategy A — consume
Wayfinder's unpublished `@rbrasier/*` packages through a shared pnpm workspace —
"designed as if C", so that every seam stays runtime-decoupled and Thread 16 can
sever the typed reuse entirely. Three years of small decisions later, the
mechanics had drifted from the intent in ways that only showed up under use:

1. **The submodule never existed.** `.gitmodules` documented
   `git submodule add … vendor/wayfinder` against a DeepCivic remote, but no
   gitlink was ever registered in the index, so `git submodule update --init` was
   a no-op. ADR-0001's "contributors must initialise the submodule" was
   unfollowable.
2. **CI tracked a moving target.** The workflow checked out
   `WAYFINDER_REF || 'main'`, so an upstream commit could turn redline's CI red
   with nothing changed here, and no SHA to bisect against. The workflow's own
   comment anticipated this: "tighten to `--frozen-lockfile` once `WAYFINDER_REF`
   is pinned to a SHA."
3. **A declared dependency made Wayfinder mandatory to install.** Three
   manifests declared `@rbrasier/domain": "workspace:*"`, so with no vendored
   tree `pnpm install` failed at the root — and with it typecheck, lint and the
   entire test suite. Threads 17 and 18 were both built and validated against an
   isolated copy of one package for this reason, which is not a gate.

What the workspace actually consumes is small enough to make (3) galling: three
functions — `typedDisplayCell`, `typedCellValue`, `computePivot` — imported by
six *test* files and by no production source at all.

## Decision

**Wayfinder is pinned to one commit by a file, and is an optional dependency of
exactly one package. The reuse it proves is a frozen contract, re-derived from
upstream by a drift check.**

- **`wayfinder.pin`** at the repo root names `repo` and `ref` (a full SHA).
  `scripts/vendor-wayfinder.sh` and the CI workflow both read it, so a local
  clone and CI materialise byte-identical trees. Bumping Wayfinder is editing
  that file.
- **Not a git submodule.** A submodule checkout puts *all four* Wayfinder
  packages under `vendor/wayfinder/packages/*`, which our pnpm workspace glob
  absorbs — dragging `@huggingface/transformers`, the OpenTelemetry SDK, minio,
  docx and pdf-parse into redline's install. Selective vendoring
  (`WAYFINDER_PACKAGES`, default `domain`) exists precisely to avoid that, and
  the two mechanisms are incompatible. `.gitmodules` is deleted rather than left
  as machinery that cannot work.
- **`@rbrasier/domain` moves to `optionalDependencies`, in `redline-adapters`
  only.** pnpm resolves an optional workspace dependency when present and
  installs cleanly when absent — verified on pnpm 9.12.0 (the pinned
  `packageManager`) and pnpm 10. `redline-domain` and `apps/redline-web` drop the
  dependency entirely, which is what CLAUDE.md's architecture rules already
  said: the domain is zero-dependency, apps import `@redline/*` only, and the
  Wayfinder reuse belongs in adapters.
- **The consumed shape is declared locally** in
  `packages/redline-adapters/src/wayfinder/wayfinder-contract.ts`, alongside the
  frozen values every other suite asserts against. The module is loaded through
  a variable specifier so `tsc` does not resolve it at compile time.
- **`wayfinder-contract.test.ts` is the drift check.** It skips when the tree is
  absent and re-derives every frozen value from the real helpers when present.
  CI vendors the pinned tree and sets `REQUIRE_WAYFINDER=1`, which turns absence
  into a hard failure — without it, a skip-when-absent design silently stops
  running. `validate.sh` warns when it skipped, so a green local run never
  implies the contract was checked.
- **The Thread 1 spike test is superseded**, not deleted. Its three assertions
  live on inside the drift check, which covers strictly more.

## Consequences

**Positive**

- `git clone && pnpm install && ./validate.sh` is green on a machine with no
  Wayfinder — 11/11 checks, with the 3 drift-check tests skipped and a warning
  saying so. That is what `validate.sh` failing checks 1–3 for two consecutive
  threads had cost us.
- Upstream can no longer turn CI red on its own schedule; a bump is a commit
  here, reviewable and revertable, and `--frozen-lockfile` becomes safe.
- The architecture rules stop being aspirational: `redline-domain` genuinely has
  zero dependencies, and `apps/redline-web` genuinely imports `@redline/*` only.
- Drift is caught in one place with a named cause, instead of six test files
  failing for reasons that read as our bug.

**Negative**

- The frozen contract is a copy, and a copy can rot. Its only guard is the drift
  check, so if CI ever stops vendoring Wayfinder the contract silently becomes
  fiction. `REQUIRE_WAYFINDER=1` is the guard on the guard.
- The locally declared interfaces duplicate types Wayfinder already exports, and
  are deliberately narrower (only what we call). A helper we start using needs a
  contract entry before it can be used.
- A contributor without a vendored tree who runs `pnpm install` will see a local
  `pnpm-lock.yaml` diff (the vendor importer and ~45 lines of optional markers).
  It must not be committed; documented in the local-dev guide.
- The pin means we are, by default, testing against a commit that ages. Nothing
  tells us upstream moved except a deliberate bump.

## Alternatives considered

- **Commit the vendored tree.** Rejected: a committed copy is a fork by another
  name — ADR-0001 rejected forking to keep release cadences independent, and
  "we never modify Wayfinder's tree" is currently enforced by the tree not being
  here at all.
- **Register a real submodule gitlink at the pinned SHA.** Rejected on evidence:
  it drags Wayfinder's entire package set and dependency tree into our install
  (above). It was the original plan for this change until the four-package glob
  was checked.
- **Delete the live import entirely and trust the frozen values.** Rejected:
  nothing would ever re-check that Wayfinder still behaves as captured, which is
  the one thing the reuse claim rests on.
- **Keep `@rbrasier/domain` as a regular dependency and require the tree.**
  Rejected: it is the status quo, and it makes a clean clone unable to run its
  own test suite.

## Enforcement

- `wayfinder.pin` is the single source of the repo/ref; `scripts/vendor-wayfinder.sh`
  warns loudly when vendoring from a checkout whose HEAD is not the pinned SHA.
- CI reads the pin, installs with `--frozen-lockfile`, and runs `validate.sh`
  with `REQUIRE_WAYFINDER=1`.
- `packages/redline-adapters/src/wayfinder/wayfinder-contract.test.ts` is the
  only place `@rbrasier/domain` may be imported. A second import site anywhere in
  `packages/*` or `apps/*` is the signal this ADR has been violated.
- `validate.sh` warns when `vendor/wayfinder/packages/domain` is absent, so a
  green run that skipped the drift check says so.
