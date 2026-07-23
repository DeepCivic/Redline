# Local dev & validation

redline mirrors Wayfinder's toolchain (pnpm 9, Node ≥ 20, Turborepo,
TypeScript 5.6 strict, Vitest 4). Two ways to run it.

## A. You have local Node ≥ 20 + pnpm

```bash
pnpm install
./validate.sh          # typecheck, lint, test + static guards
pnpm build
pnpm test
```

`validate.sh` detects local `node`/`pnpm` and runs the workspace checks directly.

## B. No local Node — run in Podman

The host may have no Node (that's how this repo was bootstrapped). `validate.sh`
and `scripts/podman-run.sh` fall back to a Node 20 container.

```bash
# from a normal host shell:
scripts/podman-run.sh                       # install + build + test
scripts/podman-run.sh "pnpm typecheck"
./validate.sh                               # auto-detects podman

# from inside a flatpak sandbox (e.g. the editor terminal), reach host podman:
PODMAN="flatpak-spawn --host podman" ./validate.sh
```

### How the Wayfinder seam works in the container

`@rbrasier/*` packages are `workspace:*` (unpublished). Rather than an on-disk
submodule, `scripts/podman-run.sh`:

1. Copies the committed `redline` tree into a **throwaway scratch dir** on a
   host-visible volume (`../.redline-scratch/…`).
2. Vendors **only the Wayfinder source we consume** into `scratch/vendor/wayfinder`
   (default: `packages/domain`; widen with `WAYFINDER_PACKAGES="domain shared"`).
3. Runs `pnpm` inside the container against that scratch workspace.

The committed repo therefore never contains Wayfinder, and the real Wayfinder
checkout is never written to. Point `WAYFINDER_DIR` at your Wayfinder checkout
(default: a sibling `../wayfinder`).

### Env overrides (`scripts/podman-run.sh`)

| Var | Default | Purpose |
|---|---|---|
| `PODMAN` | `podman` | e.g. `"flatpak-spawn --host podman"` |
| `WAYFINDER_DIR` | `../wayfinder` | Wayfinder checkout to vendor from |
| `WAYFINDER_PACKAGES` | `domain` | which `@rbrasier/*` packages to vendor |
| `IMAGE` | `docker.io/library/node:20-bookworm-slim` | container image |
| `SCRATCH_BASE` | `../.redline-scratch` | host-visible scratch base |

## What `validate.sh` checks

| # | Check | Needs Node? |
|---|---|---|
| 1 | `pnpm typecheck` (`@redline/*`) | yes (local or Podman) |
| 2 | `pnpm lint` | yes |
| 3 | `pnpm test` (incl. the Wayfinder consumption spike) | yes |
| 4 | `redline-domain` purity — relative imports only | no |
| 5 | `redline-application` purity — only redline-domain/redline-shared | no |
| 6 | no committed Wayfinder source under `vendor/` | no |
| 7 | Drizzle tables use the `redline_` prefix | no |
| 8 | no committed `.only` tests | no |
| 9 | source file size (warn ≥ 700, fail ≥ 800) | no |

Static checks (4–9) always run on the host. If neither local Node nor Podman is
available, the Node-dependent checks (1–3) `SKIP` rather than fail — but a change
is not shippable until they have been run green somewhere.
