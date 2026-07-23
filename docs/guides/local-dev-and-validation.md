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
| 6 | no committed Wayfinder source under `vendor/` (checks git, not disk) | no |
| 7 | Drizzle tables use the `redline_` prefix | no |
| 8 | no committed `.only` tests | no |
| 9 | source file size (warn ≥ 700, fail ≥ 800) | no |
| 10 | `services/womblex-ingest` pytest (isolated venv) | needs Python 3 |

Static checks (4–9) always run on the host. If neither local Node nor Podman is
available, the Node-dependent checks (1–3) `SKIP` rather than fail — but a change
is not shippable until they have been run green somewhere.

## C. Continuous integration (GitHub Actions)

`.github/workflows/ci.yml` runs the **same `./validate.sh` gate** on every push to
`main` and every PR, on a real Node 20 runner (so nothing SKIPs). Because CI has
local Node, it does not use Podman; instead it materialises the Wayfinder seam the
non-Podman way:

1. Checks out redline.
2. Checks out Wayfinder into `.wayfinder-src` (repo/ref configurable — see below).
3. Runs `scripts/vendor-wayfinder.sh` to copy the consumed `@rbrasier/*` packages
   into `vendor/wayfinder` (untracked; `.gitignore` excludes `vendor/`).
4. `pnpm install`, sets up Python 3.12, then `./validate.sh`.

`scripts/vendor-wayfinder.sh` is the non-Podman counterpart of the vendoring inside
`scripts/podman-run.sh` — same result (`@rbrasier/domain` resolvable as a workspace
package), no container. Run it locally too if you have Node but no Podman:

```bash
WAYFINDER_DIR=../wayfinder scripts/vendor-wayfinder.sh
pnpm install && ./validate.sh
```

### CI configuration (repo variables / secrets)

| Kind | Name | Default | Purpose |
|---|---|---|---|
| variable | `WAYFINDER_REPO` | `DeepCivic/wayfinder` | Wayfinder repo to check out |
| variable | `WAYFINDER_REF` | `main` | branch/tag/SHA to pin |
| secret | `WAYFINDER_TOKEN` | `github.token` | PAT with read access if Wayfinder is private |

If the Wayfinder mirror is public, no secret is needed. If it's private, add a
`WAYFINDER_TOKEN` secret (a fine-grained PAT with `contents: read` on the Wayfinder
repo) so the cross-repo checkout succeeds.
