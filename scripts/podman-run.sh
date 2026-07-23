#!/usr/bin/env bash
# Run the procautomatr workspace in a Node 20 container via Podman.
#
# Why: some hosts have no local Node/pnpm. This gives a reproducible runtime and
# keeps the Wayfinder dependency clearly delineated — Wayfinder's SOURCE (domain
# package only, for now) is vendored into a scratch copy under `vendor/wayfinder`
# so pnpm can resolve `@rbrasier/*` as workspace packages WITHOUT us ever writing
# into the real Wayfinder tree or committing it here.
#
# Usage:
#   scripts/podman-run.sh                 # install + build + test
#   scripts/podman-run.sh test            # just test
#   scripts/podman-run.sh "pnpm typecheck"
#
# Requires: podman on the host; a sibling Wayfinder checkout (see WAYFINDER_DIR).
#
# Env overrides:
#   PODMAN="flatpak-spawn --host podman"   run host podman from inside a flatpak
#   WAYFINDER_DIR=/path/to/wayfinder        Wayfinder checkout (default ../wayfinder)
#   WAYFINDER_PACKAGES="domain shared"      which @rbrasier/* packages to vendor
#   SCRATCH_BASE=/host/visible/tmp          base dir for the scratch copy
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAYFINDER_DIR="${WAYFINDER_DIR:-$REPO_ROOT/../wayfinder}"
IMAGE="${IMAGE:-docker.io/library/node:20-bookworm-slim}"
PNPM_VERSION="${PNPM_VERSION:-9.12.0}"
PODMAN="${PODMAN:-podman}"
CMD="${1:-pnpm install && pnpm build && pnpm test}"

# When podman runs on the host (e.g. via flatpak-spawn), the scratch dir must be
# on a path the host can see. Default to a sibling of the repo, which is on the
# same host-visible volume, rather than the sandbox-local /tmp.
SCRATCH_BASE="${SCRATCH_BASE:-$REPO_ROOT/../.procautomatr-scratch}"
mkdir -p "$SCRATCH_BASE"

if [ ! -d "$WAYFINDER_DIR/packages/domain" ]; then
  echo "ERROR: Wayfinder checkout not found at: $WAYFINDER_DIR" >&2
  echo "Set WAYFINDER_DIR=/path/to/wayfinder and re-run." >&2
  exit 1
fi

# Scratch workspace so container writes (node_modules, vendored source) never
# touch the committed tree or the real Wayfinder.
SCRATCH="$(mktemp -d "$SCRATCH_BASE/procautomatr-podman.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
cp -a "$REPO_ROOT/." "$SCRATCH/"
rm -rf "$SCRATCH/node_modules" "$SCRATCH"/packages/*/node_modules

# Vendor ONLY the Wayfinder packages we actually consume (Thread 1: domain only).
DEST="$SCRATCH/vendor/wayfinder"
rm -rf "$DEST"; mkdir -p "$DEST/packages"
cp "$WAYFINDER_DIR/pnpm-workspace.yaml" "$DEST/" 2>/dev/null || true
cp "$WAYFINDER_DIR/package.json"        "$DEST/" 2>/dev/null || true
cp "$WAYFINDER_DIR/tsconfig.base.json"  "$DEST/" 2>/dev/null || true
for p in ${WAYFINDER_PACKAGES:-domain}; do
  mkdir -p "$DEST/packages/$p"
  cp -a "$WAYFINDER_DIR/packages/$p/." "$DEST/packages/$p/"
done
find "$DEST" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo ">> scratch: $SCRATCH"
echo ">> vendored wayfinder packages: $(ls "$DEST/packages")"
echo ">> command: $CMD"

$PODMAN run --rm -v "$SCRATCH":/work:Z -w /work "$IMAGE" bash -lc "
  corepack enable >/dev/null 2>&1
  corepack prepare pnpm@${PNPM_VERSION} --activate >/dev/null 2>&1
  ${CMD}
"
