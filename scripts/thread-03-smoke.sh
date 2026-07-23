#!/usr/bin/env bash
# thread-03-smoke.sh — Thread 3 exit test.
#
# Proves the womblex-ingest sidecar end to end against a real MinIO:
#   1. bring up the `ingest` compose profile (minio + womblex-ingest),
#   2. POST a couple of documents to /ingest,
#   3. assert the expected shards actually landed in MinIO under proc/{eval}/,
#   4. confirm /status reports the run succeeded.
#
# Requires: podman (or docker) with compose. Uses the redline-owned stack only —
# no Wayfinder infrastructure (ADR-0002).
#
# Usage:
#   scripts/thread-03-smoke.sh                    # brings the stack up and tears it down
#   KEEP_UP=1 scripts/thread-03-smoke.sh          # leave the stack running afterwards
#   COMPOSE="docker compose" scripts/thread-03-smoke.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"
EVAL_ID="smoke-$(date +%s)"
BUCKET="${REDLINE_BUCKET:-redline}"
BASE_URL="${BASE_URL:-http://localhost:8000}"

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

echo ">> building + starting the ingest profile (minio + womblex-ingest)"
compose up -d --build

echo ">> waiting for /health"
for _ in $(seq 1 30); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "$BASE_URL/health" | grep -q '"status":"ok"' || { echo "FAIL: health never came up"; exit 1; }

echo ">> POST /ingest (evaluationId=$EVAL_ID)"
RESPONSE="$(curl -fsS -X POST "$BASE_URL/ingest" \
  -H 'content-type: application/json' \
  -d "{\"evaluationId\":\"$EVAL_ID\",\"documentNames\":[\"tender.pdf\",\"pricing.xlsx\"]}")"
echo "   -> $RESPONSE"

RUN_ID="$(printf '%s' "$RESPONSE" | sed -E 's/.*"runId":"([^"]+)".*/\1/')"
[ -n "$RUN_ID" ] || { echo "FAIL: no runId in response"; exit 1; }

echo ">> GET /status/$RUN_ID"
STATUS="$(curl -fsS "$BASE_URL/status/$RUN_ID")"
echo "   -> $STATUS"
printf '%s' "$STATUS" | grep -q '"status":"succeeded"' || { echo "FAIL: run did not succeed"; exit 1; }

echo ">> asserting shards landed in MinIO under proc/$EVAL_ID/"
EXPECTED=(
  "proc/$EVAL_ID/_manifest.parquet"
  "proc/$EVAL_ID/tender.pdf.elements.parquet"
  "proc/$EVAL_ID/pricing.xlsx.elements.parquet"
)
# List objects via the MinIO container's mc client (no host deps required).
compose exec -T minio sh -c "
  mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null 2>&1
  mc ls --recursive local/$BUCKET/proc/$EVAL_ID/
" > /tmp/redline-smoke-ls.txt || { echo "FAIL: could not list MinIO"; cat /tmp/redline-smoke-ls.txt; exit 1; }
echo "   MinIO listing:"; sed 's/^/     /' /tmp/redline-smoke-ls.txt

FAILED=0
for key in "${EXPECTED[@]}"; do
  leaf="${key#proc/$EVAL_ID/}"
  if grep -q "$leaf" /tmp/redline-smoke-ls.txt; then
    echo "   PASS  $key"
  else
    echo "   FAIL  missing $key"; FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then echo; echo "THREAD 3 EXIT TEST: FAILED"; exit 1; fi
echo; echo "THREAD 3 EXIT TEST: PASSED — shards landed in MinIO."
