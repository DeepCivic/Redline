# Local dev & validation

redline mirrors Wayfinder's toolchain (pnpm 9, Node ≥ 20, Turborepo,
TypeScript 5.6 strict, Vitest 4). Two ways to run it.

## First, on a fresh clone: the upstream submodules

```bash
git submodule update --init
```

`services/womblex` is the upstream engine and `services/wayfinder` is the fork
that serves redline's UI, both consumed as submodules. `validate.sh` **SKIPs**
rather than fails when they are absent, so a shallow clone still goes green —
but the compose `womblex` profile builds from the engine, and the fork-branch
guard (check 12) only bites when the submodule is present. CI checks them out
(`submodules: true`).

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
green build can go red with no commit in between.

Consequences to know:

- **Commit the lockfile with any dependency change.** A `package.json` edit that
  leaves `pnpm-lock.yaml` unstaged is an incomplete commit.
- **CI installs with `--frozen-lockfile`.**

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

`scripts/podman-run.sh` copies the committed tree into a **throwaway scratch
dir** on a host-visible volume (`../.redline-scratch/…`) and runs `pnpm` inside
the container against that scratch workspace, so the committed repo is never
written to.

### Env overrides (`scripts/podman-run.sh`)

| Var | Default | Purpose |
|---|---|---|
| `PODMAN` | `podman` | e.g. `"flatpak-spawn --host podman"` |
| `IMAGE` | `docker.io/library/node:20-bookworm-slim` | container image |
| `SCRATCH_BASE` | `../.redline-scratch` | host-visible scratch base |

## What `validate.sh` checks

| # | Check | Needs Node? |
|---|---|---|
| 1 | `pnpm typecheck` (`@redline/*`) | yes (local or Podman) |
| 2 | `pnpm lint` | yes |
| 3 | `pnpm test` | yes |
| 4 | `redline-domain` purity — relative imports only | no |
| 6 | Drizzle tables use the `redline_` prefix | no |
| 7 | no committed `.only` tests | no |
| 8 | source file size (warn ≥ 700, fail ≥ 800) | no |
| 9 | `services/womblex-ingest` pytest (isolated venv) | needs Python 3 |
| 11 | `ruff check` over redline's own Python (config: `ruff.toml`) | needs Python 3 |
| 12 | `services/wayfinder` sits on the branch `.gitmodules` names | needs the submodule |

Checks 5, 10 and 13 are retired — they policed a Wayfinder-vendoring step that
no longer exists (see `validate.sh` for the retirement notes).

Check 11 is the Python counterpart of check 2. Rules live in `ruff.toml` at the
root and are deliberately a floor — pyflakes plus pycodestyle's error classes, no
style regime — because the repo has no Python formatter and a lint pass that
arrives with hundreds of cosmetic findings gets switched off. The submodules are
excluded there; redline's own Python beside them is not. To run it alone:
`pipx run ruff check services/womblex-ingest`.

Static checks (4, 6-9, 11-12) always run on the host. If neither local Node nor Podman
is available, the Node-dependent checks (1–3) `SKIP` — and the run **exits 2**,
not 0, so a change is never mistaken as shippable until those checks have run
green somewhere (locally or in CI).

## C. Continuous integration (GitHub Actions)

`.github/workflows/ci.yml` runs the **same `./validate.sh` gate** on every push to
`main` and every PR, on a real Node 22 runner (so nothing SKIPs):

1. Checks out redline **with submodules**, which is where Wayfinder comes from.
2. `pnpm install`, sets up Python 3.12, then `./validate.sh`.
