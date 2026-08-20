#!/usr/bin/env bash
# validate.sh — every check that must pass before a redline change ships.
#
# Adopts Wayfinder's validate.sh spirit, adapted for this adapter:
#  - Podman-aware: if no local `node`/`pnpm`, the workspace checks run inside a
#    Node 20 container via scripts/podman-run.sh (see docs/guides/local-dev-and-validation.md).
#  - Scoped to @redline/* — this repo holds redline's own source and nothing else.
#  - Static guards (purity, prefixes, focused tests, file size) run on the host
#    with plain shell — no Node needed.
#
# Each check prints PASS / FAIL / SKIP. Exit codes:
#   0 — everything ran and passed
#   1 — a check failed
#   2 — no hard failures, but the Node workspace checks (typecheck/lint/test)
#       were SKIPPED for lack of a runner, so the change is NOT proven shippable

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
PASS=0; FAIL=0; FAILED_CHECKS=(); SKIPPED_CHECKS=()
pass() { echo -e "${GREEN}PASS${NC} — $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC} — $1"; FAIL=$((FAIL + 1)); FAILED_CHECKS+=("$1"); }
skip() { echo -e "${YELLOW}SKIP${NC} — $1"; SKIPPED_CHECKS+=("$1"); }
warn() { echo -e "${YELLOW}WARN${NC} — $1"; }
section() { echo; echo -e "${YELLOW}── $1 ──${NC}"; }

# Track whether any of the *Node workspace* checks (typecheck/lint/test) were
# skipped. A run that skips these must NOT report a clean green — those checks
# are the ones that actually compile and exercise the code. See summary below.
WS_SKIPPED=false

# ── Choose a runner: local pnpm, or Podman-backed ────────────────────────────
# run_ws "<pnpm command>" executes a workspace command either locally (if pnpm +
# node are present) or inside the container harness.
HAVE_LOCAL_NODE=false
if command -v node >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
  HAVE_LOCAL_NODE=true
fi
# Podman detection order (only needed when there's no local Node):
#   1. a working bare `podman` on PATH;
#   2. host podman reached through `flatpak-spawn --host` (editor terminals run
#      inside a flatpak sandbox that has no podman of its own).
# We probe `podman info` (not just `--version`) so a podman that exists but
# can't actually run containers is not mistaken for a usable runner.
PODMAN_BIN=""
if [ "$HAVE_LOCAL_NODE" = false ]; then
  if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    PODMAN_BIN="podman";
  elif command -v flatpak-spawn >/dev/null 2>&1 && flatpak-spawn --host podman info >/dev/null 2>&1; then
    PODMAN_BIN="flatpak-spawn --host podman";
  fi
fi

# run_ws returns:
#   0   — the workspace command ran and passed
#   127 — no runner available (infrastructure missing), caller should SKIP
#   *   — the command ran and failed (a real check failure)
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

# One-line note about how the Node checks will run, so a green result is never
# ambiguous about *what* actually executed.
if [ "$HAVE_LOCAL_NODE" = true ]; then
  echo -e "${YELLOW}runner:${NC} local node + pnpm"
elif [ -n "$PODMAN_BIN" ]; then
  echo -e "${YELLOW}runner:${NC} Node 20 container via '${PODMAN_BIN}'"
else
  echo -e "${RED}runner:${NC} none — no local node and no usable podman; workspace checks (1-3) will SKIP"
fi

# Runs a Node workspace check, mapping run_ws's exit codes onto pass/fail/skip
# and remembering when a workspace check was skipped for infra reasons.
run_ws_check() {
  local label="$1" cmd="$2"
  run_ws "$cmd"
  local rc=$?
  if [ "$rc" -eq 0 ]; then pass "$label";
  elif [ "$rc" -eq 127 ]; then WS_SKIPPED=true; skip "$label — no local node and no usable podman";
  else fail "$label"; fi
}

# ── 1. typecheck ─────────────────────────────────────────────────────────────
section "1. pnpm typecheck (@redline/*)"
run_ws_check "typecheck" "pnpm typecheck"

# ── 2. lint ──────────────────────────────────────────────────────────────────
section "2. pnpm lint (@redline/*)"
run_ws_check "lint" "pnpm lint"

# ── 3. tests ─────────────────────────────────────────────────────────────────
section "3. pnpm test (@redline/*)"
run_ws_check "tests" "pnpm test"

# ── 4. redline-domain purity (zero external imports, relative only) ─────────────
section "4. packages/redline-domain has no non-relative imports"
DOMAIN_LEAKS=$(grep -rnE "from ['\"][^.]" packages/redline-domain/src \
    --include="*.ts" --exclude="*.test.ts" 2>/dev/null \
  | grep -vE "from ['\"]\\." \
  | grep -vE "^[^:]+:[0-9]+:\s*//")
if [ -z "$DOMAIN_LEAKS" ]; then pass "redline-domain purity"; else
  fail "redline-domain purity — non-relative imports found:"; echo "$DOMAIN_LEAKS"
fi

# Checks 5 and 10 (Wayfinder vendoring / lockfile-resolved-against-vendor) are
# retired: they policed a vendoring script that no longer exists, for a tree this
# repo no longer carries.

# Check 6 (Drizzle table naming, redline_ prefix) is retired: redline is
# stateless — it stores nothing of its own, so there are no tables to name.

# ── 7. no focused tests ──────────────────────────────────────────────────────
section "7. no describe.only / it.only / test.only committed"
FOCUSED=$(grep -rnE "\b(describe|it|test)\.only\(" packages/*/src \
    --include="*.test.ts" 2>/dev/null)
if [ -z "$FOCUSED" ]; then pass "no focused tests"; else
  fail "focused tests found — remove .only:"; echo "$FOCUSED"
fi

# ── 8. source file size guard (warn ≥ 700, fail ≥ 800) ───────────────────────
section "8. source file size (warn ≥ 700, fail ≥ 800 lines)"
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

# ── 9. Python sidecar tests (services/womblex-ingest) ───────────────────────
# Runs the sidecar's pytest suite when Python is available; SKIPs cleanly on
# hosts without Python so the workspace checks still gate. Uses an isolated venv
# so the host site-packages is untouched.
section "9. services/womblex-ingest pytest"
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

# ── 11. Python lint (ruff) over redline's own Python ─────────────────────────
# The Python half of check #2's lint pass. Rules and exclusions live in ruff.toml
# at the root.
# Unlike the pytest checks above, ruff's output is NOT silenced: a
# lint failure is only actionable with its diagnostics. SKIPs cleanly when python3
# is absent or ruff cannot be installed, so an offline host still gates on the
# rest, matching check #9.
section "11. ruff lint (redline's own Python)"
RUFF_TARGETS=()
[ -d services/womblex-ingest ] && RUFF_TARGETS+=(services/womblex-ingest)
if [ ${#RUFF_TARGETS[@]} -eq 0 ]; then
  skip "ruff lint — no Python services present"
elif ! command -v python3 >/dev/null 2>&1; then
  skip "ruff lint — no python3 on host"
else
  PY_VENV="$(mktemp -d)/venv"
  if ! ( python3 -m venv "$PY_VENV" >/dev/null 2>&1 \
    && "$PY_VENV/bin/pip" install -q ruff >/dev/null 2>&1 ); then
    skip "ruff lint — could not install ruff"
  elif "$PY_VENV/bin/ruff" check "${RUFF_TARGETS[@]}"; then
    pass "ruff lint"
  else
    fail "ruff lint — fix the diagnostics above (config: ruff.toml)"
  fi
  rm -rf "$PY_VENV" 2>/dev/null || true
  find services -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
fi

# Check 12 (Wayfinder fork checkout hygiene) is retired: it policed the
# services/wayfinder submodule, and redline has no submodules. Wayfinder is a
# separate product that reaches this repo over the MCP endpoint, so there is no
# tree of its own here to keep on a branch.

# Check 13 (run-sidecar isaacus extras) is retired: it policed
# infra/docker-compose.run-sidecar.yml and infra/docker/womblex-money.Dockerfile,
# both removed — the run trigger and the money image they served are gone.

# ── Summary ──────────────────────────────────────────────────────────────────
echo; echo "──────────────────────────────────────────"
echo "Passed:  $PASS"; echo "Failed:  $FAIL"; echo "Skipped: ${#SKIPPED_CHECKS[@]}"

if [ "$FAIL" -gt 0 ]; then
  echo; echo -e "${RED}Failed checks:${NC}"
  for c in "${FAILED_CHECKS[@]}"; do echo "  - $c"; done
  echo; echo -e "${RED}Validation failed.${NC}"; exit 1
fi

# No hard failures — but a run that skipped the Node workspace checks
# (typecheck/lint/test) has NOT proven the code compiles or passes tests. Treat
# that as "not shippable from here" rather than a green tick, so this can never
# masquerade as a clean pass on a host without Node or Podman.
if [ "$WS_SKIPPED" = true ]; then
  echo
  echo -e "${YELLOW}Static + Python checks passed, but the Node workspace checks"
  echo -e "(typecheck / lint / test) were SKIPPED — no local Node and no usable"
  echo -e "Podman on this host.${NC}"
  echo
  echo "To run them locally, EITHER install Node >= 20 + pnpm, OR make Podman"
  echo "reachable. From the editor's flatpak terminal, host Podman is used"
  echo "automatically once 'flatpak-spawn --host podman info' works."
  echo
  echo -e "${RED}NOT shippable: run the workspace checks green (locally or in CI) first.${NC}"
  exit 2
fi

if [ "${#SKIPPED_CHECKS[@]}" -gt 0 ]; then
  echo; echo -e "${YELLOW}Skipped (non-blocking) checks:${NC}"
  for c in "${SKIPPED_CHECKS[@]}"; do echo "  - $c"; done
fi

echo; echo -e "${GREEN}All validations passed.${NC}"; exit 0
