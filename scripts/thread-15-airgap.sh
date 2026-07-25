#!/usr/bin/env bash
# thread-15-airgap.sh — Thread 15 exit test.
#
# Proves the whole womblex-ingest pipeline runs with ISAACUS_API_KEY UNSET —
# the air-gapped / non-Isaacus path (build plan §7 Track 5). It brings up the
# `ingest` compose profile with no Isaacus key, then asserts:
#   1. /health reports the offline enrichment mode (Isaacus not engaged),
#   2. POST /ingest succeeds and shards land in MinIO under proc/{eval}/,
#   3. the Parquet→JSON read seam (GET /extractions/...) serves the document.
#
# The default image (WOMBLEX_MODE=stub) already runs without womblex/Isaacus, so
# this is the offline default; the real, Isaacus-disabled womblex path is the
# same wiring with WOMBLEX_MODE=real on an INSTALL_WOMBLEX=1 image (womblex's own
# edge/offline mode) — still with the key unset.
#
# Requires: podman (or docker) with compose. Uses the redline-owned stack only
# (ADR-0002). Mirrors scripts/thread-03-smoke.sh.
#
# Usage:
#   scripts/thread-15-airgap.sh
#   KEEP_UP=1 scripts/thread-15-airgap.sh
#   COMPOSE="docker compose" scripts/thread-15-airgap.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"
EVAL_ID="airgap-$(date +%s)"
BUCKET="${REDLINE_BUCKET:-redline}"
BASE_URL="${BASE_URL:-http://localhost:8000}"

# The whole point of this test: no Isaacus key in the environment.
unset ISAACUS_API_KEY || true

# Provide safe local defaults for the compose S3 credentials so the script is
# self-contained (compose requires these to be set). Override via infra/.env or
# the environment for a non-default MinIO.
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"

# Pick a compose runner.
if [ -n "${COMPOSE:-}" ]; then
  :
elif command -v podman >/dev/null 2>&1; then COMPOSE="podman compose";
elif command -v docker >/dev/null 2>&1; then COMPOSE="docker compose";
else echo "ERROR: need podman or docker with compose" >&2; exit 127; fi

compose() { $COMPOSE -f "$COMPOSE_FILE" --profile ingest "$@"; }

cleanup() {
  if [ "${KEEP_UP:-0}" != "1" ]; then
    echo ">> tearing down"
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo ">> building + starting the ingest profile (no ISAACUS_API_KEY set)"
compose up -d --build

echo ">> waiting for /health"
for _ in $(seq 1 30); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
HEALTH="$(curl -fsS "$BASE_URL/health")"
echo "   -> $HEALTH"
printf '%s' "$HEALTH" | grep -q '"status":"ok"' || { echo "FAIL: health never came up"; exit 1; }

echo ">> asserting the enrichment path is offline (Isaacus not engaged)"
printf '%s' "$HEALTH" | grep -q '"enrichmentMode":"offline"' \
  || { echo "FAIL: enrichment mode is not offline — Isaacus should be disengaged"; exit 1; }
printf '%s' "$HEALTH" | grep -q '"isaacusEnabled":false' \
  || { echo "FAIL: isaacusEnabled is not false"; exit 1; }

echo ">> POST /ingest (evaluationId=$EVAL_ID)"
RESPONSE="$(curl -fsS -X POST "$BASE_URL/ingest" \
  -H 'content-type: application/json' \
  -d "{\"evaluationId\":\"$EVAL_ID\",\"documentNames\":[\"tender.pdf\"]}")"
echo "   -> $RESPONSE"
printf '%s' "$RESPONSE" | grep -q '"status":"succeeded"' || { echo "FAIL: ingest did not succeed"; exit 1; }

echo ">> asserting shards landed in MinIO under proc/$EVAL_ID/"
compose exec -T minio sh -c "
  mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null 2>&1
  mc ls --recursive local/$BUCKET/proc/$EVAL_ID/
" > /tmp/redline-airgap-ls.txt || { echo "FAIL: could not list MinIO"; cat /tmp/redline-airgap-ls.txt; exit 1; }
echo "   MinIO listing:"; sed 's/^/     /' /tmp/redline-airgap-ls.txt
grep -q "_manifest.parquet" /tmp/redline-airgap-ls.txt || { echo "FAIL: no manifest shard"; exit 1; }

echo ">> asserting the Parquet→JSON read seam serves the document"
# The stub keys documents by a source_hash; read the documentId back from the
# stored JSON read model beside the shards.
DOC_ID="$(grep -oE "[a-f0-9]+\.extraction\.json" /tmp/redline-airgap-ls.txt | head -1 | sed 's/\.extraction\.json//')"
[ -n "$DOC_ID" ] || { echo "FAIL: no extraction JSON found beside the shards"; exit 1; }
EXTRACTION="$(curl -fsS "$BASE_URL/extractions/$EVAL_ID/$DOC_ID")"
echo "   -> $(printf '%s' "$EXTRACTION" | head -c 120)…"
printf '%s' "$EXTRACTION" | grep -q "\"documentId\":\"$DOC_ID\"" || { echo "FAIL: read seam did not serve the document"; exit 1; }

echo; echo "THREAD 15 EXIT TEST: PASSED — full pipeline ran with ISAACUS_API_KEY unset (offline enrichment)."
