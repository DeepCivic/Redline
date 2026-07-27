#!/usr/bin/env bash
# womblex-engine-smoke.sh — proves the real womblex engine lands shards in redline's MinIO.
#
# Replaces the retired scripts/thread-37a-womblex-pod.sh. The ASSERTION is
# unchanged (real *.elements / *.chunks — and, with an Isaacus key, *.embeddings
# — land under proc/{evaluationId}/); what changed is that redline no longer
# supplies the pod. The engine is built from the ../services/womblex submodule
# with its OWN Dockerfile and driven through its OWN cloud runner:
#
#   1. bring up minio + the engine's Postgres job queue + its schema init,
#   2. stage the corpus into object storage (the runner's only input seam),
#   3. `womblex enqueue` the corpus, then drain it with `womblex worker`,
#   4. assert the shards landed under proc/{eval}/.
#
# The embed stage uses kanon-2-embedder (Isaacus); *.embeddings.parquet — the
# retrieval sibling — is only produced when ISAACUS_API_KEY is set. Without a key
# the extraction + chunk shards still land (the engine is proven; the embeddings
# assertion is skipped with a warning).
#
# Requires: the submodule checked out (`git submodule update --init`) and podman
# (or docker) with compose. Uses the redline-owned stack only (ADR-0002).
#
# Usage:
#   scripts/womblex-engine-smoke.sh
#   KEEP_UP=1 scripts/womblex-engine-smoke.sh
#   WOMBLEX_CORPUS=/path/to/docs scripts/womblex-engine-smoke.sh
#   COMPOSE="docker compose" scripts/womblex-engine-smoke.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"
EVAL_ID="smoke-$(date +%s)"
BUCKET="${REDLINE_BUCKET:-redline}"
CORPUS="${WOMBLEX_CORPUS:-$REPO_ROOT/services/womblex-ingest/tests/corpus}"

export WOMBLEX_EVAL_ID="$EVAL_ID"
export REDLINE_BUCKET="$BUCKET"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"

if [ ! -f "$REPO_ROOT/services/womblex/pyproject.toml" ]; then
  echo "ERROR: services/womblex is empty — run: git submodule update --init services/womblex" >&2
  exit 127
fi

# Pick a compose runner.
if [ -n "${COMPOSE:-}" ]; then
  :
elif command -v podman >/dev/null 2>&1; then COMPOSE="podman compose";
elif command -v docker >/dev/null 2>&1; then COMPOSE="docker compose";
else echo "ERROR: need podman or docker with compose" >&2; exit 127; fi

compose() { $COMPOSE -f "$COMPOSE_FILE" --profile womblex "$@"; }
compose_cli() { $COMPOSE -f "$COMPOSE_FILE" --profile womblex-cli "$@"; }

cleanup() {
  if [ "${KEEP_UP:-0}" != "1" ]; then
    echo ">> tearing down"
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo ">> bringing up minio + the engine's job queue"
compose up -d --build minio womblex-queue
compose up --build --exit-code-from womblex-init womblex-init

# The cloud runner's only input seam is object storage: stage the corpus into
# the store root so `--input-prefix inputs` resolves.
echo ">> staging corpus ($CORPUS) into s3://$BUCKET/proc/$EVAL_ID/inputs/"
compose cp "$CORPUS/." minio:/tmp/corpus
compose exec -T minio sh -c "
  set -e
  mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null
  mc mb -p local/$BUCKET >/dev/null 2>&1 || true
  mc cp --recursive /tmp/corpus/ local/$BUCKET/proc/$EVAL_ID/inputs/
"

echo ">> enqueueing the corpus"
compose_cli run --rm womblex-cli enqueue \
  --input-prefix inputs \
  --config /app/redline-config/redline.yaml

echo ">> draining the queue with the engine's worker"
# --idle-timeout turns the long-running worker into a one-shot drain so the smoke
# test terminates; production leaves it polling (see the compose command).
compose run --rm womblex worker \
  --config /app/redline-config/redline.yaml \
  --poll-interval 2 --idle-timeout 30

echo ">> asserting shards landed in MinIO under proc/$EVAL_ID/"
LISTING="$(mktemp)"
compose exec -T minio sh -c "
  mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null 2>&1
  mc ls --recursive local/$BUCKET/proc/$EVAL_ID/
" > "$LISTING" || { echo "FAIL: could not list MinIO"; cat "$LISTING"; exit 1; }
echo "   MinIO listing:"; sed 's/^/     /' "$LISTING"

FAILED=0
check() {
  if grep -q "$1" "$LISTING"; then
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

if [ "$FAILED" -ne 0 ]; then echo; echo "WOMBLEX ENGINE SMOKE: FAILED"; exit 1; fi
echo; echo "WOMBLEX ENGINE SMOKE: PASSED — the real engine landed shards in MinIO."
