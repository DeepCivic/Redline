#!/usr/bin/env bash
# thread-37a-womblex-pod.sh — Thread 37a exit test.
#
# Proves the real womblex engine runs as its own pod and lands its Parquet shards
# in the shared MinIO under proc/{evaluationId}/ — the shards the binding
# (Thread 37b) reads and serves as JSON.
#
#   1. bring up the `womblex` compose profile (minio + the womblex pod),
#   2. run the real pipeline (extract → chunk → embed) over the committed corpus,
#   3. assert the real *.elements / *.chunks (and, with an Isaacus key,
#      *.embeddings) shards landed in MinIO under proc/{eval}/.
#
# The embed stage uses kanon-2-embedder (Isaacus); *.embeddings.parquet — the
# retrieval sibling — is only produced when ISAACUS_API_KEY is set. Without a key
# the extraction + chunk shards still land (the pod is proven; the embeddings
# assertion is skipped with a warning).
#
# Requires: podman (or docker) with compose. Uses the redline-owned stack only
# (ADR-0002). Mirrors scripts/thread-03-smoke.sh.
#
# Usage:
#   scripts/thread-37a-womblex-pod.sh
#   KEEP_UP=1 scripts/thread-37a-womblex-pod.sh
#   WOMBLEX_CORPUS=/path/to/docs scripts/thread-37a-womblex-pod.sh
#   COMPOSE="docker compose" scripts/thread-37a-womblex-pod.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"
EVAL_ID="pod-$(date +%s)"
BUCKET="${REDLINE_BUCKET:-redline}"

export WOMBLEX_EVAL_ID="$EVAL_ID"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"

# Pick a compose runner.
if [ -n "${COMPOSE:-}" ]; then
  :
elif command -v podman >/dev/null 2>&1; then COMPOSE="podman compose";
elif command -v docker >/dev/null 2>&1; then COMPOSE="docker compose";
else echo "ERROR: need podman or docker with compose" >&2; exit 127; fi

compose() { $COMPOSE -f "$COMPOSE_FILE" --profile womblex "$@"; }

cleanup() {
  if [ "${KEEP_UP:-0}" != "1" ]; then
    echo ">> tearing down"
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo ">> bringing up minio (the womblex pod's only seam)"
compose up -d --build minio

echo ">> running the womblex pod over the corpus (extract → chunk → embed)"
# The pod is a one-shot worker: run it to completion rather than detaching.
compose run --rm womblex

echo ">> asserting shards landed in MinIO under proc/$EVAL_ID/"
compose exec -T minio sh -c "
  mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null 2>&1
  mc ls --recursive local/$BUCKET/proc/$EVAL_ID/
" > /tmp/redline-37a-ls.txt || { echo "FAIL: could not list MinIO"; cat /tmp/redline-37a-ls.txt; exit 1; }
echo "   MinIO listing:"; sed 's/^/     /' /tmp/redline-37a-ls.txt

FAILED=0
check() {
  if grep -q "$1" /tmp/redline-37a-ls.txt; then
    echo "   PASS  a *$1 shard landed"
  else
    echo "   FAIL  no *$1 shard"; FAILED=1
  fi
}
check ".elements.parquet"
check ".chunks.parquet"

# The retrieval sibling is Isaacus-gated (kanon-2-embedder).
if [ -n "${ISAACUS_API_KEY:-}" ]; then
  check ".embeddings.parquet"
else
  echo "   SKIP  *.embeddings.parquet — ISAACUS_API_KEY unset (embed stage did not run)"
fi

if [ "$FAILED" -ne 0 ]; then echo; echo "THREAD 37a EXIT TEST: FAILED"; exit 1; fi
echo; echo "THREAD 37a EXIT TEST: PASSED — the real womblex pod landed shards in MinIO."
