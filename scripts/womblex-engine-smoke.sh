#!/usr/bin/env bash
# womblex-engine-smoke.sh — proves the real womblex engine lands shards in redline's MinIO.
#
# Replaces the retired scripts/thread-37a-womblex-pod.sh. The engine is built
# from the ../services/womblex submodule with its OWN Dockerfile and driven
# through its OWN cloud runner:
#
#   1. bring up minio + the engine's Postgres job queue + its schema init,
#   2. stage the corpus into object storage (the runner's only input seam),
#   3. `womblex enqueue` the corpus, then drain it with `womblex worker`,
#   4. run the downstream stages chunk -> embed -> enrich -> money,
#   5. assert all eight shard classes landed under proc/{eval}/.
#
# ISAACUS_API_KEY is REQUIRED, and not only for embed. The chunk, embed and
# enrich contracts all declare an Isaacus need, and run-stage refuses a stage it
# cannot satisfy rather than publishing nothing — so without a key this script
# fails at the chunk stage instead of quietly proving less than it claims.
#
# Only chunk is satisfied by a placeholder: it makes no API call (the Kanon-2
# tokeniser is vendored in-tree), so the key is a policy gate there. embed
# (kanon-2-embedder) and enrich (kanon-2-enricher) both spend against a real
# credential, so `uat-local` gets you as far as the embed stage and no further.
#
# Requires: the submodule checked out (`git submodule update --init`) and podman
# (or docker) with compose. Uses the redline-owned stack only.
#
# Usage:
#   scripts/womblex-engine-smoke.sh
#   KEEP_UP=1 scripts/womblex-engine-smoke.sh
#   WOMBLEX_CORPUS=/path/to/docs scripts/womblex-engine-smoke.sh
#   COMPOSE="docker compose" scripts/womblex-engine-smoke.sh
#
# Driving a real corpus run rather than a smoke test — the shards must land
# under the prefix the evaluation will be read back at, and must survive the run:
#   KEEP_UP=1 WOMBLEX_EVAL_ID=<manifest's evaluationId> \
#     WOMBLEX_CORPUS=/path/to/corpus scripts/womblex-engine-smoke.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"
# Caller-supplied when this drives a real corpus: the sidecar reads shards from
# proc/{evaluationId}/, so a run whose id does not match the evaluation's is
# invisible to it. Defaults to a throwaway id for the smoke case.
EVAL_ID="${WOMBLEX_EVAL_ID:-smoke-$(date +%s)}"
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

# Checked here rather than at the chunk stage so the failure names its cause.
# Any non-empty value satisfies chunk; only embed spends against a real key.
if [ -z "${ISAACUS_API_KEY:-}" ]; then
  echo "ERROR: ISAACUS_API_KEY is unset — run-stage refuses both chunk and embed." >&2
  echo "       Set it in infra/uat/.env.uat (uat-local is sufficient for chunk)." >&2
  exit 78
fi

# Pick a compose runner.
if [ -n "${COMPOSE:-}" ]; then
  :
elif command -v podman >/dev/null 2>&1; then COMPOSE="podman compose";
elif command -v docker >/dev/null 2>&1; then COMPOSE="docker compose";
else echo "ERROR: need podman or docker with compose" >&2; exit 127; fi

compose() { $COMPOSE -f "$COMPOSE_FILE" --profile womblex "$@"; }
compose_cli() { $COMPOSE -f "$COMPOSE_FILE" --profile womblex-cli "$@"; }
compose_stage() { $COMPOSE -f "$COMPOSE_FILE" --profile stage "$@"; }

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

# The worker persists EXTRACTION shards only — it computes chunking and discards
# it. chunk and embed are separate passes over the run's shard prefix, which is
# what `womblex run-stage` does. Without these two the assertions below can never
# pass, however healthy the run looks.
#
# The run id is the worker's, not ours, so read it back off the store.
RUN_ID="$(compose exec -T minio sh -c "
  mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null 2>&1
  mc ls local/$BUCKET/proc/$EVAL_ID/runs/ 2>/dev/null
" | awk '{print $NF}' | tr -d '/' | grep '^run-' | sort | tail -1)"

if [ -z "$RUN_ID" ]; then
  echo "FAIL: no run- directory under proc/$EVAL_ID/runs/ — the worker published nothing" >&2
  exit 1
fi
echo ">> running the downstream stages over $RUN_ID"

# Ordering is load-bearing, not cosmetic. `enrich` takes chunks as a NON-STRICT
# input: without them it still succeeds, but every entity lands with
# chunk_index = -1 and the graph cannot be joined to chunk text. `money` reads
# the element shards only, so it is independent of both — it is last because
# nothing downstream of it needs its output first.
for stage in chunk embed enrich money; do
  echo "   -- run-stage --stage $stage"
  compose_stage run --rm stage \
    --stage "$stage" --run-id "$RUN_ID" \
    --config /app/redline-config/redline.yaml
done

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
check ".embeddings.parquet"
# enrich writes exactly three sidecars here: `_enrich_outputs` adds
# *.enrichment_doc.parquet only under `persist_document` or an AI
# `chunking.chunking_model`, and redline sets neither.
check ".enrichment_entities.parquet"
check ".enrichment_meta.parquet"
check ".graph_edges.parquet"
# money_columns is the per-column verdict audit that makes redline.yaml's
# PROVISIONAL header/veto terms falsifiable — assert it, not just the spans.
check ".money_spans.parquet"
check ".money_columns.parquet"

if [ "$FAILED" -ne 0 ]; then echo; echo "WOMBLEX ENGINE SMOKE: FAILED"; exit 1; fi
echo; echo "WOMBLEX ENGINE SMOKE: PASSED — the real engine landed shards in MinIO."
