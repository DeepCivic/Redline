#!/usr/bin/env bash
# validate.sh — every check that must pass before a redline change ships.
#
# Adopts Wayfinder's validate.sh spirit, adapted for this adapter:
#  - Podman-aware: if no local `node`/`pnpm`, the workspace checks run inside a
#    Node 20 container via scripts/podman-run.sh (see docs/guides/local-dev-and-validation.md).
#  - Scoped to @redline/* — the vendored Wayfinder tree is never checked.
#  - Static guards (purity, prefixes, focused tests, file size) run on the host
#    with plain shell — no Node needed.
#
# Exits non-zero on any failure. Each check prints PASS / FAIL / SKIP.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
PASS=0; FAIL=0; FAILED_CHECKS=()
pass() { echo -e "${GREEN}PASS${NC} — $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC} — $1"; FAIL=$((FAIL + 1)); FAILED_CHECKS+=("$1"); }
skip() { echo -e "${YELLOW}SKIP${NC} — $1"; }
warn() { echo -e "${YELLOW}WARN${NC} — $1"; }
section() { echo; echo -e "${YELLOW}── $1 ──${NC}"; }

# ── Choose a runner: local pnpm, or Podman-backed ────────────────────────────
# run_ws "<pnpm command>" executes a workspace command either locally (if pnpm +
# node are present) or inside the container harness.
HAVE_LOCAL_NODE=false
if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  HAVE_LOCAL_NODE=true
fi
PODMAN_BIN=""
if [ "$HAVE_LOCAL_NODE" = false ]; then
  if command -v podman >/dev/null 2>&1; then PODMAN_BIN="podman";
  elif command -v flatpak-spawn >/dev/null 2>&1 && flatpak-spawn --host podman --version >/dev/null 2>&1; then
    PODMAN_BIN="flatpak-spawn --host podman";
  fi
fi

run_ws() {
  local cmd="$1"
  if [ "$HAVE_LOCAL_NODE" = true ]; then
    bash -lc "$cmd"
  elif [ -n "$PODMAN_BIN" ]; then
    PODMAN="$PODMAN_BIN" bash "$ROOT/scripts/podman-run.sh" "pnpm install >/dev/null 2>&1 && $cmd"
  else
    return 127
  fi
}

WS_AVAILABLE=true
if [ "$HAVE_LOCAL_NODE" = false ] && [ -z "$PODMAN_BIN" ]; then
  WS_AVAILABLE=false
fi

# ── 1. typecheck ─────────────────────────────────────────────────────────────
section "1. pnpm typecheck (@redline/*)"
if [ "$WS_AVAILABLE" = false ]; then
  skip "typecheck — no local node and no podman available"
elif run_ws "pnpm typecheck"; then pass "typecheck"; else fail "typecheck"; fi

# ── 2. lint ──────────────────────────────────────────────────────────────────
section "2. pnpm lint (@redline/*)"
if [ "$WS_AVAILABLE" = false ]; then
  skip "lint — no local node and no podman available"
elif run_ws "pnpm lint"; then pass "lint"; else fail "lint"; fi

# ── 3. tests ─────────────────────────────────────────────────────────────────
section "3. pnpm test (@redline/*)"
if [ "$WS_AVAILABLE" = false ]; then
  skip "tests — no local node and no podman available"
elif run_ws "pnpm test"; then pass "tests"; else fail "tests"; fi

# ── 4. redline-domain purity (zero external imports, relative only) ─────────────
section "4. packages/redline-domain has no non-relative imports"
DOMAIN_LEAKS=$(grep -rnE "from ['\"][^.]" packages/redline-domain/src \
    --include="*.ts" --exclude="*.test.ts" 2>/dev/null \
  | grep -vE "from ['\"]\\." \
  | grep -vE "^[^:]+:[0-9]+:\s*//")
if [ -z "$DOMAIN_LEAKS" ]; then pass "redline-domain purity"; else
  fail "redline-domain purity — non-relative imports found:"; echo "$DOMAIN_LEAKS"
fi

# ── 5. redline-application purity ───────────────────────────────────────────────
# May import only @redline/redline-domain and @redline/redline-shared.
section "5. packages/redline-application imports only redline-domain and redline-shared"
APP_LEAKS=$(grep -rnE "from ['\"][^.]" packages/redline-application/src \
    --include="*.ts" --exclude="*.test.ts" 2>/dev/null \
  | grep -vE "from ['\"]@redline/(redline-domain|redline-shared)['\"/]" \
  | grep -vE "^[^:]+:[0-9]+:\s*//")
if [ -z "$APP_LEAKS" ]; then pass "redline-application purity"; else
  fail "redline-application purity — imports outside redline-domain/redline-shared:"; echo "$APP_LEAKS"
fi

# ── 6. Wayfinder tree untouched ──────────────────────────────────────────────
# We must never *commit* a copy of Wayfinder into this repo. The tree may exist
# on disk at build time (CI materialises it via scripts/vendor-wayfinder.sh; the
# Podman harness uses its own scratch copy), but it must stay untracked — .gitignore
# excludes vendor/. This checks what git tracks, not what's on disk.
section "6. vendor/wayfinder not committed into this repo"
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TRACKED_WAYFINDER=$(git ls-files -- 'vendor/wayfinder/**' 2>/dev/null)
  if [ -z "$TRACKED_WAYFINDER" ]; then pass "no committed Wayfinder source"; else
    fail "vendor/wayfinder is tracked in git — it must be materialised at build time, never committed:"
    echo "$TRACKED_WAYFINDER" | head
  fi
elif [ -d vendor/wayfinder ] && [ -n "$(find vendor/wayfinder -type f 2>/dev/null | head -1)" ]; then
  # No git available: fall back to the filesystem heuristic.
  fail "vendor/wayfinder contains files and git is unavailable to verify it is untracked"
else
  pass "no committed Wayfinder source"
fi

# ── 7. DB table naming (redline_ prefix) ────────────────────────────────────────
section "7. all Drizzle tables match ^redline_[a-z_]+\$"
SCHEMA_GLOB="packages/redline-adapters/src"
if [ -d "$SCHEMA_GLOB" ]; then
  BAD_TABLES=$(grep -rhE "pgTable\(\"[^\"]+\"" "$SCHEMA_GLOB" 2>/dev/null \
    | sed -E 's/.*pgTable\("([^"]+)".*/\1/' \
    | grep -vE "^redline_[a-z_]+$" || true)
  if [ -z "$BAD_TABLES" ]; then pass "table names (or none yet)"; else
    fail "table names — must use the redline_ prefix:"; echo "$BAD_TABLES"
  fi
else
  skip "table names — no adapters schema yet"
fi

# ── 8. no focused tests ──────────────────────────────────────────────────────
section "8. no describe.only / it.only / test.only committed"
FOCUSED=$(grep -rnE "\b(describe|it|test)\.only\(" packages/*/src \
    --include="*.test.ts" 2>/dev/null)
if [ -z "$FOCUSED" ]; then pass "no focused tests"; else
  fail "focused tests found — remove .only:"; echo "$FOCUSED"
fi

# ── 9. source file size guard (warn ≥ 700, fail ≥ 800) ───────────────────────
section "9. source file size (warn ≥ 700, fail ≥ 800 lines)"
SIZE_FAILURES=""; SIZE_WARNINGS=""
while IFS= read -r f; do
  lc=$(wc -l < "$f")
  [ "$lc" -lt 700 ] && continue
  if [ "$lc" -ge 800 ]; then SIZE_FAILURES+="  $lc  $f\n"; else SIZE_WARNINGS+="  $lc  $f\n"; fi
done < <(find packages/*/src apps/*/src services/*/src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.py" \) \
  ! -name "*.test.ts" ! -name "*.test.tsx" 2>/dev/null)
[ -n "$SIZE_WARNINGS" ] && { warn "files ≥ 700 lines — split when next touched:"; printf '%b' "$SIZE_WARNINGS"; }
if [ -z "$SIZE_FAILURES" ]; then pass "no source file ≥ 800 lines"; else
  fail "source files ≥ 800 lines — decompose:"; printf '%b' "$SIZE_FAILURES"
fi

# ── 10. Python sidecar tests (services/womblex-ingest) ───────────────────────
# Runs the sidecar's pytest suite when Python is available; SKIPs cleanly on
# hosts without Python so the workspace checks still gate. Uses an isolated venv
# so the host site-packages is untouched.
section "10. services/womblex-ingest pytest"
if [ ! -d services/womblex-ingest ]; then
  skip "womblex-ingest — service not present"
elif ! command -v python3 >/dev/null 2>&1; then
  skip "womblex-ingest pytest — no python3 on host"
else
  PY_VENV="$(mktemp -d)/venv"
  if python3 -m venv "$PY_VENV" >/dev/null 2>&1 \
    && "$PY_VENV/bin/pip" install -q -e 'services/womblex-ingest[dev]' >/dev/null 2>&1 \
    && ( cd services/womblex-ingest && "$PY_VENV/bin/python" -m pytest -q >/dev/null 2>&1 ); then
    pass "womblex-ingest pytest"
  else
    fail "womblex-ingest pytest"
  fi
  rm -rf "$PY_VENV" services/womblex-ingest/src/*.egg-info services/womblex-ingest/.pytest_cache 2>/dev/null || true
  find services/womblex-ingest -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo; echo "──────────────────────────────────────────"
echo "Passed: $PASS"; echo "Failed: $FAIL"
if [ $FAIL -eq 0 ]; then echo -e "${GREEN}All validations passed.${NC}"; exit 0; fi
echo; echo -e "${RED}Failed checks:${NC}"
for c in "${FAILED_CHECKS[@]}"; do echo "  - $c"; done
echo; echo -e "${RED}Validation failed.${NC}"; exit 1
