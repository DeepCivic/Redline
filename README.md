# Redline

> **Redline is a read-only MCP server providing verbatim access to Womblex
> extraction assets for provenance-backed report assembly.**

Repository: [`DeepCivic/Redline`](https://github.com/DeepCivic/Redline).

[![CI](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml/badge.svg)](https://github.com/DeepCivic/Redline/actions/workflows/ci.yml)

## What it is, and what it refuses to be

Redline is headless and stateless. It serves what Womblex extracted, byte for
byte, and does nothing else.

**No LLM generation happens here.** Redline never paraphrases, summarises,
infers or composes. A tool call returns source text exactly as Womblex wrote it,
or it returns an error — there is no third outcome in which Redline supplies
content of its own. That refusal is the product: a report assembled from these
tools is grounded in the extraction, and every value in it resolves back to a
document.

**It stores nothing.** No database, no run state, no report. Two identical calls
return identical bytes because the assets are immutable and the reads are pure.

## The three services

| | Responsibility | Boundary |
| --- | --- | --- |
| **Womblex** | Ingests unstructured documents; persists elements, chunks, table cells, form fields, money spans and graph edges as versioned Parquet assets | The source of truth. No LLM generation, no report assembly |
| **Redline** (this repo) | Serves those assets verbatim over MCP, so a client can discover schemas and fetch exact source snippets | Headless, stateless, read-only. Refuses to paraphrase or generate |
| **Wayfinder** | The human-in-the-loop interface: the chat surface where an LLM helps a person define a report schema, then assembles the report from Redline's reads | All UI, user intent and workflow state. Delegates every fetch to Redline |

The seams are deliberate and narrow. Womblex reaches Redline through object
storage; Redline reaches Wayfinder through one MCP endpoint. **None of the three
is carried inside another** — there are no submodules in this repository, and
nothing here imports Womblex or Wayfinder source.

What Redline depends on from Womblex is its output schema, and that is written
down rather than vendored: see
[`docs/Womblex-Output-Contract.md`](./docs/Womblex-Output-Contract.md).

## Layout

```
redline/
├── docs/
│   ├── Redline-Status.md             # what is present, and what is outstanding
│   ├── Wayfinder-Integration.md      # the contract Wayfinder builds against
│   └── Womblex-Output-Contract.md    # the Womblex schemas Redline reads
├── packages/
│   ├── redline-domain/               # ports (zero deps, Result pattern)
│   └── redline-adapters/             # the sidecar's Parquet→JSON read client
├── apps/
│   └── redline-mcp/                  # the MCP tool surface (streamable HTTP)
├── services/
│   └── womblex-ingest/               # the Parquet→JSON read sidecar (Python)
└── infra/                            # compose: MinIO + sidecar + MCP
```

## Status

Under construction. [`docs/Redline-Status.md`](./docs/Redline-Status.md) is the
one live document: what is actually in the repository today, and what is
outstanding with its exit test.

## Toolchain

pnpm 9, Node ≥ 20, Turborepo, TypeScript 5.6 (strict), Vitest 4, Prettier,
ESLint 9; Python 3.11+ with ruff and pytest for the sidecar.

```bash
pnpm install
pnpm build      # turbo run build across @redline/* packages
pnpm test       # vitest across @redline/*
pnpm typecheck
pnpm lint
./validate.sh   # the full gate — also what CI runs
```

There is no submodule step. `git clone` is a complete checkout.

CI (`.github/workflows/ci.yml`) runs the same `./validate.sh` gate on every push to
`main` and every PR. See [`docs/guides/local-dev-and-validation.md`](./docs/guides/local-dev-and-validation.md).

### Running without a local Node (Podman)

If the host has no Node/pnpm, `scripts/podman-run.sh` runs the workspace inside a
reproducible Node 20 container:

```bash
scripts/podman-run.sh                 # install + build + test
scripts/podman-run.sh "pnpm typecheck"
```
