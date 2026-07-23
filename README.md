# Redline

> **Procurement Evaluation Adapter** — a Wayfinder plugin/adapter (its own repo) for
> procurement response evaluation. Integrates **womblex** (document extraction) and
> **Numbatch** (no-code classification, extended with configurable financial table
> extraction), and reuses Wayfinder's typed tabular/XLSX helpers read-only.

Repository: [`DeepCivic/Redline`](https://github.com/DeepCivic/Redline).

## Status

Under construction. See the living build plan and progress log at
[`docs/procurement-evaluation-plan.md`](./docs/procurement-evaluation-plan.md).

Current thread: **Thread 4 — Extraction reader adapter (Parquet→JSON boundary).**
(Threads 1–3 are ✅ complete and verified — scaffold, `redline-domain`, and the
`womblex-ingest` sidecar with its exit test passing against real MinIO.)

## Architecture

A true **adapter**, not a Wayfinder fork. Wayfinder is consumed at runtime seams
(HTTP/MCP + object storage + a separate `redline_`-prefixed DB schema) and its typed
domain helpers are reused read-only. See [ADR-0001](./docs/adr/0001-adapter-over-wayfinder.adr.md).

Publishing target: the **DeepCivic** org.

```
redline/
├── docs/
│   ├── adr/                     # architecture decision records (Wayfinder ADR model)
│   └── procurement-evaluation-plan.md
├── packages/
│   ├── redline-domain/             # entities + ports (zero deps, Result pattern)
│   ├── redline-application/        # use-cases
│   ├── redline-adapters/           # Parquet/JSON reader, Numbatch client, repositories
│   └── redline-shared/             # zod schemas shared with the UI
├── apps/
│   └── redline-web/                # specialist control surface + review grid
├── services/                    # womblex-ingest, numbatch (added in later threads)
└── vendor/
    └── wayfinder/               # git submodule (strategy A) — typed reuse only
```

## Wayfinder consumption strategy

Strategy **A** (submodule + typed reuse), designed at every seam **as if C** (fully
runtime-decoupled) so the plugin only ever depends on Wayfinder's ports. Wayfinder's
`@rbrasier/*` packages are `workspace:*` (unpublished), so they are resolved through a
shared pnpm workspace that includes `vendor/wayfinder/packages/*`.

## Toolchain

Mirrors Wayfinder: pnpm 9, Node ≥ 20, Turborepo, TypeScript 5.6 (strict), Vitest 4,
Prettier, ESLint 9.

```bash
pnpm install
pnpm build      # turbo run build across @redline/* packages
pnpm test       # vitest — includes the Wayfinder consumption spike
pnpm typecheck
pnpm lint
```

### Running without a local Node (Podman)

If the host has no Node/pnpm, use the reproducible container harness. It vendors the
required Wayfinder source into a throwaway scratch copy inside the container (so the
committed tree and the real Wayfinder tree are never touched) and runs pnpm there:

```bash
WAYFINDER_DIR=/path/to/wayfinder scripts/podman-run.sh            # install + build + test
WAYFINDER_DIR=/path/to/wayfinder scripts/podman-run.sh "pnpm typecheck"
# widen the vendored Wayfinder set when later threads need more packages:
WAYFINDER_PACKAGES="domain shared" scripts/podman-run.sh
```
