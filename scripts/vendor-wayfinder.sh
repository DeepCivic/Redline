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

# The pinned commit (wayfinder.pin) is the reference redline is built against.
PIN_FILE="$REPO_ROOT/wayfinder.pin"
PINNED_REF="$(grep -E '^ref=' "$PIN_FILE" 2>/dev/null | cut -d= -f2)"
PINNED_REPO="$(grep -E '^repo=' "$PIN_FILE" 2>/dev/null | cut -d= -f2)"

if [ ! -d "$WAYFINDER_DIR/packages/domain" ]; then
  echo "ERROR: Wayfinder checkout not found at: $WAYFINDER_DIR" >&2
  echo "Set WAYFINDER_DIR=/path/to/wayfinder and re-run." >&2
  echo "The pinned source is $PINNED_REPO @ $PINNED_REF (see wayfinder.pin)." >&2
  exit 1
fi

# Vendoring from an unpinned checkout is allowed — it is how you test an
# upstream bump — but it must never be silent, because the drift check's verdict
# then describes a commit the pin does not name.
SOURCE_REF="$(git -C "$WAYFINDER_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
if [ -n "$PINNED_REF" ] && [ "$SOURCE_REF" != "$PINNED_REF" ]; then
  echo "WARNING: vendoring Wayfinder at $SOURCE_REF, which is not the pinned $PINNED_REF." >&2
  echo "         Update wayfinder.pin if this bump is intended." >&2
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
