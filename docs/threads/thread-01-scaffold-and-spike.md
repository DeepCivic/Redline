# Thread 1 — Repo scaffold & Wayfinder consumption spike

**Status:** ✅ Complete · **Date:** 2026-07-23 · **Version intent:** initial scaffold (pre-1.0)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 0](../procurement-evaluation-plan.md)
· ADR: [ADR-0001](../adr/0001-adapter-over-wayfinder.adr.md)

## Goal

Stand up the `procautomatr` pnpm monorepo mirroring Wayfinder's toolchain, and
prove **Strategy A** — that we can import and run a typed helper from Wayfinder's
unpublished `@rbrasier/domain` package.

**Exit test:** `pnpm build` green; a test importing `typedDisplayCell` passes.

## What was built

### Workspace
- `package.json` — turbo scripts scoped `--filter=@procautomatr/*` so vendored
  Wayfinder packages are never built/linted/tested by us.
- `pnpm-workspace.yaml` — `apps/*`, `packages/*`, and the seam `vendor/wayfinder/packages/*`.
- `turbo.json`, `tsconfig.base.json`, `tsconfig.json`, `.prettierrc`, `.gitignore`,
  `.gitmodules` (Wayfinder submodule → DeepCivic remote).
- `eslint.config.mjs` — flat config; `proc-domain` non-test source restricted to
  relative imports; `vendor/**` ignored.

### Packages
| Package | Thread 1 contents |
|---|---|
| `@procautomatr/proc-domain` | Zero-dep `Result`/`DomainError` primitives; `index.ts`; the **consumption spike** `wayfinder-spike.test.ts`. |
| `@procautomatr/proc-shared` | Placeholder `index.ts` (zod schemas land Thread 2+). |
| `@procautomatr/proc-application` | Placeholder `index.ts` (use-cases land Thread 10). |
| `@procautomatr/proc-adapters` | Placeholder `index.ts`; declares `@rbrasier/domain` dep. |

### Tooling & docs
- `scripts/podman-run.sh` — Node-20-in-Podman harness (host has no local Node).
- `validate.sh` — Podman-aware; 9 checks (see the guide).
- `.claude/` — adapted skill/command set + `CLAUDE.md` routing index.
- `docs/adr/` — Wayfinder ADR model adopted; ADR-0001 written.
- `docs/guides/local-dev-and-validation.md`.

## The Wayfinder seam (delineation)

Wayfinder is **not** copied into the committed tree. `scripts/podman-run.sh`
vendors only the Wayfinder source we consume (Thread 1: `packages/domain`, which
is zero-dep) into a throwaway scratch workspace inside the container, where pnpm
resolves `@rbrasier/*` as workspace packages. The real Wayfinder tree is never
written to; `validate.sh` check #6 fails if Wayfinder source is ever committed here.

## Exit-test evidence

Run in `node:20-bookworm-slim` via Podman, pnpm 9.12.0:

```
pnpm build     → Tasks: 4 successful, 4 total
pnpm test      → Tasks: 7 successful, 7 total
                 proc-domain: wayfinder-spike.test.ts (3 tests) — 3 passed
pnpm typecheck → Tasks: 7 successful, 7 total
./validate.sh  → Passed: 9  Failed: 0  — All validations passed.
```

The spike asserts `typedDisplayCell("currency", "1200.50") → { value: 1200.5, isNumeric: true }`,
imported from `@rbrasier/domain`.

## Known limitations / follow-ups

1. `procautomatr` is not yet a git repo. `git init` + add the DeepCivic remote.
2. `vendor/wayfinder` is wired only for the Podman path. For local (non-Podman)
   dev, add the submodule (`git submodule add git@github.com:DeepCivic/wayfinder.git vendor/wayfinder`)
   or symlink a sibling checkout.
3. No `VERSION` file yet (pre-1.0). Add when the first release line opens.

## How to reproduce

```bash
WAYFINDER_DIR=/path/to/wayfinder ./validate.sh        # or: PODMAN="flatpak-spawn --host podman" ...
```
See [local-dev-and-validation.md](../guides/local-dev-and-validation.md).
