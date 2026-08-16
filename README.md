# Redline

> **Corpus-ingest-and-report substrate** — a Wayfinder plugin (its own repo). A
> specialist stages a corpus of documents from the browser, the **womblex** engine
> extracts, chunks, embeds, enriches and prices it, and the chunks, enrichment
> graph, money spans and extraction JSON that run lands serve two consumers: the
> Create Corpus UI and redline's MCP report tools. Reuses Wayfinder's typed
> tabular/XLSX helpers read-only.

Repository: [`DeepCivic/Redline`](https://github.com/DeepCivic/Redline).

[![CI](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml/badge.svg)](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml)

## Status

Under construction. Two documents govern:
[`docs/architecture.md`](./docs/architecture.md) is what redline **is**, and
[`docs/delivery-plan.md`](./docs/delivery-plan.md) is what is **left to build**.
Durable design rationale lives in [`docs/design-principles.md`](./docs/design-principles.md);
it does not track work.

The substrate is built and green under `./validate.sh`: the `womblex-ingest`
sidecar (the read seam, the run trigger/status seam and the chunk / money-span /
graph loads), the `redline_` persistence layer and its four store adapters, the
object-store staging seam, the Create Corpus control surface and run tracker
mounted in the forked Wayfinder, and the MCP report tool surface.

**The Evaluation surface was removed on 2026-08-15.** redline no longer models a
judgement over a corpus: it serves the rows a run landed, and interpreting them
belongs to a consumer above the store. See
[`design-principles.md`](./docs/design-principles.md) §2.

## Architecture

A **plugin**, not a Wayfinder fork of its own. Wayfinder is consumed at runtime seams
(HTTP/MCP + object storage + a separate `redline_`-prefixed DB schema) and its typed
domain helpers are reused read-only.

Publishing target: the **DeepCivic** org.

```
redline/
├── docs/
│   ├── architecture.md          # what redline IS (design truth)
│   ├── delivery-plan.md         # what is LEFT TO BUILD (tracking truth)
│   └── design-principles.md     # durable adopted-principles + non-goals (not tracking)
├── packages/
│   ├── redline-domain/             # ports (zero deps, Result pattern)
│   ├── redline-adapters/           # sidecar client, object store, redline_ stores
│   └── redline-shared/             # zod schemas shared with the UI
├── apps/
│   ├── redline-web/                # the Create Corpus brain + run tracker
│   └── redline-mcp/                # the report tool surface (MCP over HTTP)
├── services/
│   ├── womblex/                 # SUBMODULE: the womblex engine @ latest main
│   ├── womblex-ingest/          # redline's read + run sidecar
│   └── wayfinder/               # SUBMODULE: the Wayfinder fork that serves the UI
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
submodule.

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
`main` and every PR. See [`docs/guides/local-dev-and-validation.md`](./docs/guides/local-dev-and-validation.md).

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

How to drive the surface the fork serves, written for the people who use it
rather than the people who build it:

- [Creating a corpus](./docs/guides/create-a-corpus.md) — the **Create Corpus**
  screen: build the dataset. Upload the documents, pick the extraction parameters
  and the stages, run it.

Operator runbooks live beside them:
[running both stacks locally](./docs/guides/two-stack-local-run.md) and
[local dev and validation](./docs/guides/local-dev-and-validation.md).
