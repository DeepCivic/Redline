# Redline

> **Grounded extraction output → CSV.** Turns a batch of already-extracted
> document content (womblex output — never the engine itself) into a downloadable
> CSV where every non-empty cell is copied verbatim from, or deterministically
> normalised from, a span of that content that a deterministic verifier re-reads
> and matches. An LLM may reason, search and select; it may not author a cell
> value.

Repository: [`DeepCivic/Redline`](https://github.com/DeepCivic/Redline).

[![CI](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml/badge.svg)](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml)

## Status

Under construction. [`docs/Redline-Plan.md`](./docs/Redline-Plan.md) is the one
document that governs — the core invariant, data contracts, milestones and
acceptance criteria all live there; nothing here restates it.

**The prior corpus-ingest-and-report architecture (Create Corpus UI, MCP report
tool surface, the `redline_` persistence layer and its object-store/Postgres
adapters) was removed.** It does not serve the plan above, and the repository was
stripped back to what does. Milestone M0 (baseline compiles) is where the strip's
dangling references were cleared; M1 onward builds the plan's contracts, reader
and verifier fresh.

## Architecture

A **plugin**, not a Wayfinder fork of its own. Wayfinder is consumed at runtime
seams only, and only from M6 — see the plan's milestones.

Publishing target: the **DeepCivic** org.

```
redline/
├── docs/
│   └── Redline-Plan.md          # the one governing document — design + tracking
├── packages/
│   ├── redline-domain/             # ports (zero deps, Result pattern)
│   └── redline-adapters/           # port implementations against real systems
├── services/
│   ├── womblex/                 # SUBMODULE: the womblex engine @ latest main
│   ├── womblex-ingest/          # redline's read + run sidecar
│   └── wayfinder/               # SUBMODULE: the Wayfinder fork (mounted from M6)
└── vendor/
    └── wayfinder/               # materialised at build time (never committed) — typed reuse only
```

## Wayfinder consumption strategy

Strategy **A** (vendored typed reuse), designed at every seam **as if C** (fully
runtime-decoupled) so the plugin only ever depends on Wayfinder's ports. Wayfinder's
`@rbrasier/*` packages are `workspace:*` (unpublished), so they are resolved through a
shared pnpm workspace that includes `vendor/wayfinder/packages/*`.

The tree is **materialised, never committed**: `scripts/vendor-wayfinder.sh` copies
only the package we consume out of the `services/wayfinder` submodule, so the tree
redline typechecks against is the tree it runs in. It is an **optional**
dependency — `pnpm install` and `./validate.sh` are green with no Wayfinder
present, and the one suite that needs it skips. To bump Wayfinder, move the
submodule. Not consumed at all until M6.

## Toolchain

Mirrors Wayfinder: pnpm 9, Node ≥ 20, Turborepo, TypeScript 5.6 (strict), Vitest 4,
Prettier, ESLint 9.

```bash
git submodule update --init   # services/womblex + services/wayfinder
pnpm install
pnpm build      # turbo run build across @redline/* packages
pnpm test       # vitest across @redline/*
pnpm typecheck
pnpm lint
./validate.sh   # the full gate — also what CI runs
```

CI (`.github/workflows/ci.yml`) runs the same `./validate.sh` gate on every push to
`main` and every PR.

### Running without a local Node (Podman)

If the host has no Node/pnpm, use the reproducible container harness. It vendors the
required Wayfinder source into a throwaway scratch copy inside the container (so the
committed tree and the real Wayfinder tree are never touched) and runs pnpm there:

```bash
WAYFINDER_DIR=/path/to/wayfinder scripts/podman-run.sh            # install + build + test
WAYFINDER_DIR=/path/to/wayfinder scripts/podman-run.sh "pnpm typecheck"
# widen the vendored Wayfinder set when later work needs more packages:
WAYFINDER_PACKAGES="domain shared" scripts/podman-run.sh
```

## User guides

None yet — the plan has no served surface before M6 (mounting the CSV download
in the forked Wayfinder). Operator/dev-loop guidance until then is this README
plus [`docs/Redline-Plan.md`](./docs/Redline-Plan.md).
