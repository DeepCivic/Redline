# Redline

> **Corpus-ingest-and-report substrate** — a Wayfinder plugin (its own repo). A
> specialist stages a corpus of documents, the **womblex** engine extracts, chunks,
> embeds, enriches and prices it, and the chunks, graph, money spans and
> extraction JSON that run lands serve redline's own per-document report
> extraction engine and its MCP report tools.

Repository: [`DeepCivic/Redline`](https://github.com/DeepCivic/Redline).

[![CI](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml/badge.svg)](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml)

## Status

Under construction. [`docs/Redline-Plan.md`](./docs/Redline-Plan.md) is the one
live plan: the product statement (what redline delivers), then the delivery
detail — data model, architecture, build steps and their exit tests.

**Nothing here models a judgement over a corpus.** redline serves the rows a
run landed and the report engine's per-document extraction; interpreting what
those rows mean is a step described in the plan, not a store-side concern.

## Architecture

A **plugin**, not a Wayfinder fork of its own. Wayfinder is consumed at runtime
seams (HTTP/MCP + object storage) and, later, a separate `redline_`-prefixed DB
schema for the report domain (see the plan's step 2).

Publishing target: the **DeepCivic** org.

```
redline/
├── docs/
│   └── Redline-Plan.md          # the one live plan: product statement + delivery detail
├── packages/
│   ├── redline-domain/          # ports (zero deps, Result pattern)
│   └── redline-adapters/        # the womblex sidecar's Parquet→JSON read client
├── apps/
│   └── redline-mcp/             # the report tool surface (MCP over HTTP)
└── services/
    ├── womblex/                 # SUBMODULE: the womblex engine @ latest main
    ├── womblex-ingest/          # redline's read sidecar
    └── wayfinder/               # SUBMODULE: the Wayfinder fork that serves the UI
```

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

If the host has no Node/pnpm, `scripts/podman-run.sh` runs the workspace inside a
reproducible Node 20 container:

```bash
scripts/podman-run.sh                 # install + build + test
scripts/podman-run.sh "pnpm typecheck"
```
