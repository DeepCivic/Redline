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

## Dependency policy — the lockfile is committed

`pnpm-lock.yaml` **is committed**, and the CI cache keys on it. Every direct
dependency in this workspace is a caret range (`typescript: ^5.6.0`,
`vitest: ^4.1.0`, …), so without a lockfile every install re-resolves and a
green build can go red with no commit in between — a real cost when threads are
built one-per-agent and gated on `./validate.sh`.

Consequences to know:

- **Commit the lockfile with any dependency change.** A `package.json` edit that
  leaves `pnpm-lock.yaml` unstaged is an incomplete commit.
- **CI installs with `--prefer-frozen-lockfile`, not `--frozen-lockfile`** (which
  pnpm enables by default when `CI=true`). The lockfile contains an importer for
  `vendor/wayfinder/packages/domain`, materialised from Wayfinder at
  `WAYFINDER_REF` (default `main`). A dependency bump in *Wayfinder's* repo would
  staleness-fail a strict install and turn our CI red for someone else's commit.
  The tolerant flag re-resolves in that case instead of failing.
- **Upgrade to `--frozen-lockfile` when `WAYFINDER_REF` is pinned to a SHA.** That
  makes the vendored tree deterministic, at which point strictness costs nothing.

Regenerate after changing dependencies:

```bash
pnpm install           # updates pnpm-lock.yaml
git add pnpm-lock.yaml
```

## B. No local Node — run in Podman

The host may have no Node (that's how this repo was bootstrapped). `validate.sh`
and `scripts/podman-run.sh` fall back to a Node 20 container.

```bash
# from a normal host shell:
scripts/podman-run.sh                       # install + build + test
scripts/podman-run.sh "pnpm typecheck"
./validate.sh                               # auto-detects podman

# from inside a flatpak sandbox (e.g. the editor terminal): validate.sh now
# auto-detects host podman via `flatpak-spawn --host` — no prefix needed once
# `flatpak-spawn --host podman info` works. You can still force it explicitly:
PODMAN="flatpak-spawn --host podman" ./validate.sh
```

> **No false greens.** `validate.sh` probes `podman info` (not just `--version`),
> so a podman that can't actually run containers won't be mistaken for a working
> one. If neither local Node nor a usable Podman is found, the Node checks (1-3)
> `SKIP` and the script **exits 2 with a "NOT shippable" notice** rather than
> printing "All validations passed". Exit codes: `0` all passed, `1` a check
> failed, `2` workspace checks were skipped (not proven shippable).

### How the Wayfinder seam works in the container

`@rbrasier/*` packages are `workspace:*` (unpublished). Rather than an on-disk
checkout of Wayfinder, `scripts/podman-run.sh`:

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
available, the Node-dependent checks (1–3) `SKIP` — and the run **exits 2**, not
0, so a change is never mistaken as shippable until those checks have run green
somewhere (locally or in CI).

## C. Continuous integration (GitHub Actions)

`.github/workflows/ci.yml` runs the **same `./validate.sh` gate** on every push to
`main` and every PR, on a real Node 22 runner (so nothing SKIPs). Because CI has
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

### Without Wayfinder at all

Since ADR-0012, Wayfinder is an **optional** dependency: `pnpm install` and
`./validate.sh` are green on a clean clone with no `vendor/wayfinder`. The three
drift-check tests skip, and validate.sh prints a `WARN` saying so, so a green run never
implies the Wayfinder contract was verified. CI vendors the pinned tree and sets
`REQUIRE_WAYFINDER=1`, which turns an unresolvable `@rbrasier/domain` into a hard
failure rather than a skip.

> **Note:** running `pnpm install` *without* a vendored tree rewrites `pnpm-lock.yaml`
> (it drops the `vendor/wayfinder/packages/domain` importer, ~45 lines). That diff is a
> local artefact of your environment — do not commit it. The committed lockfile is the
> one CI uses, generated with the tree present.

### CI configuration (repo variables / secrets)

| Kind | Name | Default | Purpose |
|---|---|---|---|
| variable | `WAYFINDER_REPO` | `repo=` in `wayfinder.pin` | one-off override of the pinned repo |
| variable | `WAYFINDER_REF` | `ref=` in `wayfinder.pin` | one-off override of the pinned commit |
| secret | `WAYFINDER_TOKEN` | `github.token` | PAT with read access if you point `WAYFINDER_REPO` at a private repo |

**Bump Wayfinder by editing [`wayfinder.pin`](../../wayfinder.pin), not CI.** The pin
names `rbrasier/wayfinder` at a full SHA, and both CI and `scripts/vendor-wayfinder.sh`
read it, so the two materialise identical trees (ADR-0012). After a bump, re-vendor and
run `pnpm install && ./validate.sh`; the drift check
(`packages/redline-adapters/src/wayfinder/wayfinder-contract.test.ts`) is what tells you
whether the new commit still satisfies the contract redline reuses. The repository
variables above stay available for a one-off experiment without committing a pin change.

The default `rbrasier/wayfinder` is public, so no secret is needed. If you point
`WAYFINDER_REPO` at a private repo, add a `WAYFINDER_TOKEN` secret (a fine-grained
PAT with `contents: read` on that repo) so the cross-repo checkout succeeds.
