# Thread 01a — Wayfinder seam: pinned, and optional at install time

**Status:** ✅ Complete · **Date:** 2026-07-25 · **Version intent:** PATCH (pre-1.0; no behaviour change — build/test infrastructure and test-only reuse)

A revision of [Thread 1](./thread-01-scaffold-and-spike.md)'s Wayfinder
consumption seam, not a new thread. Locks
[ADR-0012](../adr/0012-wayfinder-is-pinned-and-optional.adr.md), which amends
[ADR-0001](../adr/0001-adapter-over-wayfinder.adr.md).

## Why

Two defects in the seam, both found while validating Thread 18:

1. **Nothing was pinned.** CI checked out Wayfinder at a moving `main`, so an
   upstream commit could turn redline red with no change here and no SHA to
   bisect. `.gitmodules` described a submodule that was never registered in the
   index, so the documented `git submodule update --init` did nothing.
2. **Wayfinder was mandatory to install.** Three manifests declared
   `@rbrasier/domain": "workspace:*"`, so without a vendored tree `pnpm install`
   failed at the root — taking typecheck, lint and the whole suite with it.
   Threads 17 and 18 were both validated against an isolated copy of one package
   for this reason, which is not a gate.

The consumed surface is three functions in six test files, and no production
source. That is not a dependency worth failing a clean clone over.

## What changed

### Pinned — `wayfinder.pin` (new)

`repo=rbrasier/wayfinder` + `ref=d3c2f4e7…` — the canonical upstream, at a real
commit. `scripts/vendor-wayfinder.sh` and `.github/workflows/ci.yml` both read
it, so CI and a local clone materialise the same tree. The script warns loudly
when vendoring from a checkout whose HEAD is not the pin, because the drift
check's verdict would otherwise describe a commit the pin does not name.

`.gitmodules` is **deleted**. A submodule checkout puts all four Wayfinder
packages under `vendor/wayfinder/packages/*`, which our workspace glob absorbs —
pulling `@huggingface/transformers`, the OpenTelemetry SDK, minio, docx and
pdf-parse into redline's install. Selective vendoring exists to prevent exactly
that, so the two mechanisms cannot coexist (ADR-0012, Alternatives).

CI now installs with `--frozen-lockfile`, which the workflow's own comment said
to do "once `WAYFINDER_REF` is pinned to a SHA", and runs `validate.sh` with
`REQUIRE_WAYFINDER=1`.

### Optional — the dependency and the seam

| Package | Before | After |
|---|---|---|
| `redline-domain` | `devDependencies` | **removed** — the domain is zero-dependency, as CLAUDE.md always said |
| `redline-adapters` | `dependencies` | `optionalDependencies` — the one package CLAUDE.md sanctions for Wayfinder reuse |
| `apps/redline-web` | `devDependencies` | **removed** — apps import `@redline/*` only |

pnpm resolves an optional workspace dependency when present and installs
cleanly when absent. Verified on **pnpm 9.12.0** (the pinned `packageManager`,
what CI runs) and pnpm 10.

### New — `packages/redline-adapters/src/wayfinder/wayfinder-contract.ts`

The locally declared shape of what we consume, the frozen values captured from
upstream at the pinned commit, and `loadWayfinderDomain()` — a runtime load
through a variable specifier, so `tsc` does not resolve the module at compile
time and a clean clone typechecks. Returns `null` when absent, unless
`REQUIRE_WAYFINDER=1`, which rethrows.

### New — `wayfinder-contract.test.ts` (the drift check)

Re-derives every frozen value from the real helpers: 5 `typedDisplayCell` cases,
2 `typedCellValue` cases, and the full `computePivot` roll-up. Skips when the
tree is absent. This is now the **only** place `@rbrasier/domain` is imported.

### Moved and rewritten — the six oracle imports

`wayfinder-spike.test.ts` (Thread 1's exit proof) is superseded by the drift
check, which covers strictly more; its three assertions survive as frozen cases.
The four remaining tests each appended a Wayfinder cross-check to an assertion
about our own output — those cross-checks consolidate into the drift check, and
the tests keep their own assertions unchanged.

### Honest reporting — `validate.sh`

Warns when `vendor/wayfinder/packages/domain` is absent, so a green local run
never implies the contract was verified.

## Evidence

Three runs, all on this host with Node 22 + pnpm:

```
1. Wayfinder present, REQUIRE_WAYFINDER=1   (CI's path)
   ./validate.sh → Passed: 11  Failed: 0
   domain 95 · application 16 · adapters 46 · web 58 tests, all green

2. No vendor/wayfinder at all               (a clean clone)
   pnpm install → clean
   ./validate.sh → Passed: 11  Failed: 0
   WARN — no vendor/wayfinder — the Wayfinder contract drift check SKIPPED
   adapters: 43 passed | 3 skipped (46)

3. No vendor/wayfinder, REQUIRE_WAYFINDER=1 (the guard on the guard)
   FAIL src/wayfinder/wayfinder-contract.test.ts
   Error: Cannot find package '@rbrasier/domain'
```

Run 2 is the point of the change: **`./validate.sh` is green on a machine with
no Wayfinder**, which it had not been for the two preceding threads. Run 3 proves
CI cannot silently stop checking the contract.

`pnpm install --frozen-lockfile` verified on pnpm 9.12.0 with the vendored tree:
"Lockfile is up to date, resolution step is skipped".

## Known limitations / follow-ups

1. **The pin ages by design.** Nothing reports that upstream has moved; a bump is
   a deliberate edit to `wayfinder.pin`. A scheduled CI job that vendors
   upstream `main` and runs only the drift check would turn that into a signal —
   worth doing when someone is next in this area.
2. **A contributor with no vendored tree sees a `pnpm-lock.yaml` diff** after
   `pnpm install` (the vendor importer, ~45 lines). It must not be committed.
   Documented in the local-dev guide.
3. **The frozen contract is narrower than Wayfinder's API** — only the three
   helpers we call. Using a fourth means adding a contract entry first, which is
   the intended friction.
4. **Thread 16 gets smaller.** "Sever the submodule seam" is now mostly done: the
   remaining work is deciding whether to keep the drift check or drop the reuse
   claim entirely once redline stands alone.
5. **Thread 17's follow-up 1 and Thread 18's follow-up 1 are resolved by this
   revision** — `validate.sh` can now run green in a container with no Wayfinder.
