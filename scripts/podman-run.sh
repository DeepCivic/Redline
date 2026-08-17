#!/usr/bin/env bash
# Run the redline workspace in a Node 20 container via Podman.
#
# Why: some hosts have no local Node/pnpm. This gives a reproducible runtime
# without touching the host's Node install.
#
# Usage:
#   scripts/podman-run.sh                 # install + build + test
#   scripts/podman-run.sh test            # just test
#   scripts/podman-run.sh "pnpm typecheck"
#
# Requires: podman on the host.
#
# Env overrides:
#   PODMAN="flatpak-spawn --host podman"   run host podman from inside a flatpak
#   SCRATCH_BASE=/host/visible/tmp          base dir for the scratch copy
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-docker.io/library/node:20-bookworm-slim}"
PNPM_VERSION="${PNPM_VERSION:-9.12.0}"
PODMAN="${PODMAN:-podman}"
CMD="${1:-pnpm install && pnpm build && pnpm test}"

# When podman runs on the host (e.g. via flatpak-spawn), the scratch dir must be
# on a path the host can see. Default to a sibling of the repo, which is on the
# same host-visible volume, rather than the sandbox-local /tmp.
SCRATCH_BASE="${SCRATCH_BASE:-$REPO_ROOT/../.redline-scratch}"
mkdir -p "$SCRATCH_BASE"

# Scratch workspace so container writes (node_modules) never touch the
# committed tree.
SCRATCH="$(mktemp -d "$SCRATCH_BASE/redline-podman.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
cp -a "$REPO_ROOT/." "$SCRATCH/"
rm -rf "$SCRATCH/node_modules" "$SCRATCH"/packages/*/node_modules "$SCRATCH"/apps/*/node_modules

echo ">> scratch: $SCRATCH"
echo ">> command: $CMD"

$PODMAN run --rm -v "$SCRATCH":/work:Z -w /work "$IMAGE" bash -lc "
  corepack enable >/dev/null 2>&1
  corepack prepare pnpm@${PNPM_VERSION} --activate >/dev/null 2>&1
  ${CMD}
"
