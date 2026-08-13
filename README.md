# Redline

> **Procurement Evaluation Adapter** — a Wayfinder plugin/adapter (its own repo)
> for procurement response evaluation, built as a composable **comprehension
> lens**: it sorts a document corpus against user-defined criteria, surfaces only
> genuine collisions for a specialist to resolve, and remembers those resolutions
> as reusable boundary logic — so the evaluation is useful before any classifier
> is trained. Integrates **womblex** (document extraction + embeddings) and
> **Numbatch** (no-code classification, extended with configurable financial table
> extraction), and reuses Wayfinder's typed tabular/XLSX helpers read-only.

Repository: [`DeepCivic/Redline`](https://github.com/DeepCivic/Redline).

[![CI](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml/badge.svg)](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml)

## Status

Under construction. Two documents govern:
[`docs/architecture.md`](./docs/architecture.md) is what redline **is**, and
[`docs/delivery-plan.md`](./docs/delivery-plan.md) is what is **left to build**.
Durable design rationale lives in [`docs/design-principles.md`](./docs/design-principles.md);
it does not track work.

The foundations are built and green under `./validate.sh`: the scaffold,
`redline-domain` (user-defined requirements + the lens domain), the
`womblex-ingest` sidecar + store-side chunk surface, the extraction reader
adapters, the Numbatch classifier + service scaffold, the financial extension,
the `redline_` persistence layer, the orchestration use-cases, the
workflow-manager control surface, the review grid/pivots/Excel export, and the
cold-start classification path (hard-rule + adjudication over exact fetch).

**Current focus — the lean vertical**: get a real procurement corpus ingested and
rendered on screen, delineated by topic and brand. The comprehension-lens work is
deferred until that exists. The outstanding items are the money-sidecar financial
extractor, mounting the review UI into the forked Wayfinder, and the real-corpus
run — see [`delivery-plan.md`](./docs/delivery-plan.md) §2.

## Architecture

A true **adapter**, not a Wayfinder fork. Wayfinder is consumed at runtime seams
(HTTP/MCP + object storage + a separate `redline_`-prefixed DB schema) and its typed
domain helpers are reused read-only.

Publishing target: the **DeepCivic** org.

```
redline/
├── docs/
│   ├── adr/                     # architecture decision records (Wayfinder ADR model)
│   ├── architecture.md          # what redline IS (design truth)
│   ├── delivery-plan.md         # what is LEFT TO BUILD (tracking truth)
│   └── design-principles.md     # durable adopted-principles + non-goals (not tracking)
├── packages/
│   ├── redline-domain/             # entities + ports (zero deps, Result pattern)
│   ├── redline-application/        # use-cases
│   ├── redline-adapters/           # Parquet/JSON reader, Numbatch client, repositories
│   └── redline-shared/             # zod schemas shared with the UI
├── apps/
│   └── redline-web/                # specialist control surface + review grid
├── services/
│   ├── womblex/                 # SUBMODULE: the womblex engine @ v0.3.0
│   ├── womblex-ingest/          # redline's Parquet→JSON read sidecar
│   ├── numbatch/                # SUBMODULE: the Numbatch fork @ 72bcead
│   └── numbatch-extension/      # redline's additive overlay on the fork
└── vendor/
    └── wayfinder/               # materialised at build time (never committed) — typed reuse only
```

## Wayfinder consumption strategy

Strategy **A** (vendored typed reuse), designed at every seam **as if C** (fully
runtime-decoupled) so the plugin only ever depends on Wayfinder's ports. Wayfinder's
`@rbrasier/*` packages are `workspace:*` (unpublished), so they are resolved through a
shared pnpm workspace that includes `vendor/wayfinder/packages/*`.

The tree is **materialised, never committed**: `scripts/vendor-wayfinder.sh` copies
only the package we consume, from the commit named in [`wayfinder.pin`](./wayfinder.pin).
It is an **optional** dependency — `pnpm install` and `./validate.sh` are green with no
Wayfinder present, and the one suite that needs it skips (ADR-0012). To bump Wayfinder,
edit `wayfinder.pin`.

## Toolchain

Mirrors Wayfinder: pnpm 9, Node ≥ 20, Turborepo, TypeScript 5.6 (strict), Vitest 4,
Prettier, ESLint 9.

```bash
git submodule update --init   # services/womblex + services/numbatch (ADR-0015)
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

How to drive the surfaces the fork serves, written for the people who use them
rather than the people who build them. Two screens, two jobs, usually two people:

- [Creating a corpus](./docs/guides/create-a-corpus.md) — the **Create Corpus**
  screen: name the run, upload the documents, author the config, watch it land.
- [Creating an evaluation](./docs/guides/create-an-evaluation.md) — the **New
  evaluation** screen: over a corpus that has been run, say whose response is
  whose and what to read out of it.

Both describe the flow the delivery plan is building towards, and each ends with
a short note on what the deployed build still does differently.

Operator runbooks live beside them:
[running both stacks locally](./docs/guides/two-stack-local-run.md) and
[local dev and validation](./docs/guides/local-dev-and-validation.md).
