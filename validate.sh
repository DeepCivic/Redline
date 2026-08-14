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

# Wayfinder is an optional dependency (ADR-0012): the suite runs without it, but
# the drift check that re-derives the frozen @rbrasier/domain contract can only
# run when the tree is vendored. Say so rather than let a green run imply the
# contract was verified. CI sets REQUIRE_WAYFINDER=1, which makes absence fail.
if [ ! -d "$ROOT/vendor/wayfinder/packages/domain" ]; then
  warn "no vendor/wayfinder — the Wayfinder contract drift check SKIPPED (run scripts/vendor-wayfinder.sh)"
fi

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
# services/womblex, services/numbatch and services/wayfinder are the vendored
# upstream submodules — source we never modify (the Wayfinder fork carries
# redline's mount on its `main` branch, but that tree is the fork's
# to shape, not redline source to lint), excluded from our own static guards
# exactly as vendor/wayfinder is. redline's own overlay lives in
# services/numbatch-extension and IS checked.
done < <(find packages/*/src apps/*/src services/*/src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.py" \) \
  ! -path "services/womblex/*" ! -path "services/numbatch/*" ! -path "services/wayfinder/*" \
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

# ── 11. Numbatch financial extension tests (services/numbatch-extension) ─────
# The Thread 6 overlay: financial_profiles/financial_extractions models, the
# Alembic migration, and the config API. redline's OWN code, which is why it
# lives beside the upstream submodule rather than inside it (services/numbatch is
# the unmodified fork). Provable standalone (SQLite; no fork, no GPU). SKIPs
# cleanly when python3 is absent so the workspace checks still gate.
section "11. services/numbatch-extension/financial_extension pytest"
FIN_EXT=services/numbatch-extension/financial_extension
if [ ! -d "$FIN_EXT" ]; then
  skip "numbatch financial extension — not present"
elif ! command -v python3 >/dev/null 2>&1; then
  skip "numbatch financial extension pytest — no python3 on host"
else
  PY_VENV="$(mktemp -d)/venv"
  if python3 -m venv "$PY_VENV" >/dev/null 2>&1 \
    && "$PY_VENV/bin/pip" install -q -e "$FIN_EXT[dev]" >/dev/null 2>&1 \
    && ( cd "$FIN_EXT" && "$PY_VENV/bin/python" -m pytest -q >/dev/null 2>&1 ); then
    pass "numbatch financial extension pytest"
  else
    fail "numbatch financial extension pytest"
  fi
  rm -rf "$PY_VENV" "$FIN_EXT"/src/*.egg-info "$FIN_EXT/.pytest_cache" 2>/dev/null || true
  find "$FIN_EXT" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
fi

# ── 12. pnpm-lock.yaml was resolved against the vendored Wayfinder tree ──────
# pnpm-workspace.yaml globs vendor/wayfinder/packages/* into the workspace, but
# vendor/ is never committed (check #6) — so the lockfile is a function of state
# that is deliberately absent from the repo. `pnpm install` WITHOUT vendoring
# first silently drops the vendor/wayfinder/packages/domain importer and flips its
# transitive deps to `optional`; committing that fails CI's --frozen-lockfile
# install for a reason that has nothing to do with the change under review.
#
# The invariant is the lockfile's *content*, not its git status: a legitimate
# dependency bump may rewrite it freely, so long as it was resolved with the tree
# vendored. Fix by materialising Wayfinder and re-installing:
#   scripts/vendor-wayfinder.sh && pnpm install
# then `git checkout -- pnpm-lock.yaml` if you only meant to install.
# Scoped to a lockfile that BOTH lacks the importer AND differs from HEAD, so it
# fires on the rewrite and not on a repo that legitimately carries no Wayfinder
# importer at all. ADR-0012's "green without Wayfinder" therefore still holds for
# a clean clone — right up until an unvendored install rewrites the lockfile,
# which is precisely the state that must not be committed.
section "12. pnpm-lock.yaml was not rewritten by an unvendored install"
LOCKFILE_IMPORTER='^  vendor/wayfinder/packages/[a-z-]+:'
if [ ! -f pnpm-lock.yaml ]; then
  skip "lockfile — no pnpm-lock.yaml"
elif grep -qE "$LOCKFILE_IMPORTER" pnpm-lock.yaml; then
  pass "lockfile resolved against the vendored tree"
elif ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  skip "lockfile — git unavailable to compare against HEAD"
elif git diff --quiet -- pnpm-lock.yaml 2>/dev/null; then
  pass "lockfile has no Wayfinder importer, but matches HEAD — not a local rewrite"
else
  fail "pnpm-lock.yaml was rewritten without the vendored Wayfinder tree (the vendor/wayfinder importer is gone). Do not commit it: run 'git checkout -- pnpm-lock.yaml', or vendor first ('scripts/vendor-wayfinder.sh && pnpm install') if you meant to change dependencies"
fi

# ── 13. Python lint (ruff) over redline's own Python ─────────────────────────
# The Python half of check #3's lint pass. Rules and exclusions live in ruff.toml
# at the root — including the two upstream submodules, which we never modify
# (ADR-0015). Unlike the pytest checks above, ruff's output is NOT silenced: a
# lint failure is only actionable with its diagnostics. SKIPs cleanly when python3
# is absent or ruff cannot be installed, so an offline host still gates on the
# rest, matching checks #10 and #11.
section "13. ruff lint (redline's own Python)"
RUFF_TARGETS=()
[ -d services/womblex-ingest ] && RUFF_TARGETS+=(services/womblex-ingest)
[ -d services/numbatch-extension ] && RUFF_TARGETS+=(services/numbatch-extension)
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

# ── 14. Wayfinder fork hygiene (services/wayfinder submodule) ────────────────
# The Wayfinder fork is a submodule we RUN and EDIT (ADR-0019), unlike the
# byte-identical Python submodules. One invariant replaces "never modified": the
# checkout is on the fork's `main` branch commit the superproject
# records — redline's mount lives on johntooth/wayfinder's `main`.
#
# This is the only Wayfinder pin redline has. The gitlink alone fixes both the
# runtime mount and the vendored build-time tree (scripts/vendor-wayfinder.sh
# copies out of this checkout), so there is no second ref that can drift from it.
#
# The check once also asserted the fork's `main` had not diverged from
# rbrasier's — protecting a clean upstreaming diff. redline builds and runs
# against johntooth/wayfinder only, so that guard policed a relationship we do
# not have, and PR #9 breached it with no consequence. Removed rather than left
# failing. The branch is read from .gitmodules, so it follows a rename there
# rather than hard-coding a name.
#
# SKIPs (never fails) on a clone without the submodule initialised, matching the
# clean-clone posture of the checks above.
section "14. Wayfinder fork checkout is on the branch .gitmodules names"
if [ ! -d services/wayfinder/.git ] && [ ! -f services/wayfinder/.git ]; then
  skip "wayfinder fork — services/wayfinder not initialised (git submodule update --init)"
elif ! command -v git >/dev/null 2>&1; then
  skip "wayfinder fork — git unavailable"
else
  WF_CONFIGURED_BRANCH="$(git config -f .gitmodules submodule.services/wayfinder.branch 2>/dev/null)"
  WF_CURRENT_BRANCH="$(git -C services/wayfinder rev-parse --abbrev-ref HEAD 2>/dev/null)"
  # (a) The submodule must sit on the branch .gitmodules names. A detached HEAD
  # (git's default submodule checkout) reads as "HEAD" and is allowed only when
  # it points at that branch's commit — so we compare commits, not branch names,
  # to stay robust to a detached-but-correct checkout.
  # --verify --quiet, not a bare rev-parse: a bare `git rev-parse <unknown-ref>`
  # ECHOES its argument to stdout before failing, so the fallback below would set
  # this to the literal string "origin/main" rather than leaving
  # it empty — silently defeating every emptiness test downstream.
  WF_BRANCH_SHA="$(git -C services/wayfinder rev-parse --verify --quiet "origin/${WF_CONFIGURED_BRANCH}" 2>/dev/null || git -C services/wayfinder rev-parse --verify --quiet "${WF_CONFIGURED_BRANCH}" 2>/dev/null)"
  WF_HEAD_SHA="$(git -C services/wayfinder rev-parse HEAD 2>/dev/null)"
  WF_ON_BRANCH=false
  if [ "$WF_CURRENT_BRANCH" = "$WF_CONFIGURED_BRANCH" ]; then WF_ON_BRANCH=true;
  elif [ -n "$WF_BRANCH_SHA" ] && [ "$WF_HEAD_SHA" = "$WF_BRANCH_SHA" ]; then WF_ON_BRANCH=true; fi

  if [ "$WF_ON_BRANCH" != true ] && [ -z "$WF_BRANCH_SHA" ]; then
    # Neither a branch name nor a resolvable branch commit: a shallow submodule
    # checkout (actions/checkout's `git submodule update --depth=1`) fetches the
    # pinned commit detached and NO branch refs, so a correct checkout is
    # indistinguishable from a wrong one. Refusing here failed every CI run from
    # this check's introduction (966361b) onward. Skip rather than assert what
    # cannot be observed. The workflow fetches the ref so CI still exercises the
    # guard.
    warn "wayfinder fork: '${WF_CONFIGURED_BRANCH}' is not resolvable in services/wayfinder — a shallow checkout carries no branch refs, so a detached-but-correct HEAD cannot be told from a wrong one"
    skip "wayfinder fork — no ${WF_CONFIGURED_BRANCH} ref to compare HEAD against"
  elif [ "$WF_ON_BRANCH" != true ]; then
    fail "wayfinder fork: checkout is not on '${WF_CONFIGURED_BRANCH}' (redline's mount must live only there). Run 'git submodule update --init' or 'git -C services/wayfinder checkout ${WF_CONFIGURED_BRANCH}'"
  else
    pass "wayfinder fork on ${WF_CONFIGURED_BRANCH}"
  fi
fi

# ── 15. the run-capable sidecar builds with the isaacus extra ────────────────
# The money image installs the engine WITHOUT `isaacus` on purpose — the money op
# is offline. infra/docker-compose.run-sidecar.yml reuses that image to serve the
# run trigger, which drives chunk/embed/enrich, and `isaacus_available()` tests
# the SDK before the key. Built on the default extras, that sidecar fails every
# run at the chunk stage while holding a valid ISAACUS_API_KEY and reporting
# itself healthy. Static because the alternative is a 7 GB image build: this
# reads the two lines that have to agree.
section "15. run-sidecar builds the engine with the isaacus extra"
RUN_SIDECAR_COMPOSE=infra/docker-compose.run-sidecar.yml
if [ ! -f "$RUN_SIDECAR_COMPOSE" ]; then
  skip "run-sidecar extras — $RUN_SIDECAR_COMPOSE not present"
elif ! grep -qE '^\s*ARG EXTRAS=' infra/docker/womblex-money.Dockerfile 2>/dev/null; then
  fail "infra/docker/womblex-money.Dockerfile hardcodes its engine extras — declare 'ARG EXTRAS=cloud' and install \"./womblex-engine[\${EXTRAS}]\" so the run sidecar can opt into isaacus"
elif ! grep -qE 'EXTRAS:.*isaacus' "$RUN_SIDECAR_COMPOSE"; then
  fail "$RUN_SIDECAR_COMPOSE does not pass the isaacus extra — add 'args: {EXTRAS: cloud,isaacus}' to womblex-run-sidecar's build, or its runs fail at the chunk stage with a valid key set"
else
  pass "run-sidecar builds the engine with the isaacus extra"
fi

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
