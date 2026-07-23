#!/usr/bin/env bash
# vendor-wayfinder.sh — populate vendor/wayfinder from a Wayfinder checkout so
# pnpm can resolve the `@rbrasier/*` workspace packages redline consumes.
#
# This is the non-Podman counterpart to the vendoring that scripts/podman-run.sh
# does inside its container. CI (which has a real Node) calls this, then runs the
# workspace commands directly. Local Podman dev does NOT need this — podman-run.sh
# vendors into its own scratch copy.
#
# We never commit vendor/wayfinder (validate.sh check #6 enforces this); it is a
# build-time materialisation only. Honours ADR-0001 ("design as if C").
#
# Usage:
#   scripts/vendor-wayfinder.sh                     # from ../wayfinder, domain only
#   WAYFINDER_DIR=/path/to/wayfinder scripts/vendor-wayfinder.sh
#   WAYFINDER_PACKAGES="domain shared" scripts/vendor-wayfinder.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAYFINDER_DIR="${WAYFINDER_DIR:-$REPO_ROOT/../wayfinder}"
WAYFINDER_PACKAGES="${WAYFINDER_PACKAGES:-domain}"

if [ ! -d "$WAYFINDER_DIR/packages/domain" ]; then
  echo "ERROR: Wayfinder checkout not found at: $WAYFINDER_DIR" >&2
  echo "Set WAYFINDER_DIR=/path/to/wayfinder and re-run." >&2
  exit 1
fi

DEST="$REPO_ROOT/vendor/wayfinder"
rm -rf "$DEST"
mkdir -p "$DEST/packages"

# The workspace scaffolding pnpm needs to treat vendor/wayfinder as a nested
# workspace root for the @rbrasier/* packages.
cp "$WAYFINDER_DIR/pnpm-workspace.yaml" "$DEST/" 2>/dev/null || true
cp "$WAYFINDER_DIR/package.json" "$DEST/" 2>/dev/null || true
cp "$WAYFINDER_DIR/tsconfig.base.json" "$DEST/" 2>/dev/null || true

for package in $WAYFINDER_PACKAGES; do
  if [ ! -d "$WAYFINDER_DIR/packages/$package" ]; then
    echo "ERROR: Wayfinder package not found: packages/$package" >&2
    exit 1
  fi
  mkdir -p "$DEST/packages/$package"
  cp -a "$WAYFINDER_DIR/packages/$package/." "$DEST/packages/$package/"
done

# Never carry the source repo's installed modules into our workspace.
find "$DEST" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo "vendored wayfinder packages into $DEST/packages: $(ls "$DEST/packages")"
