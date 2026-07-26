#!/usr/bin/env bash
# womblex-pod-entrypoint.sh — run the real womblex pipeline and land its shards in
# MinIO under proc/{evaluationId}/ (Thread 37a).
#
# The womblex pod's only seam is object storage (ADR-0002): it extracts + chunks
# (+ embeds, when ISAACUS_API_KEY is set) a mounted corpus into a shard directory,
# then syncs that directory to the shared bucket. The womblex-ingest API pod
# (Thread 37b) reads those shards and serves them as JSON.
set -euo pipefail

INPUT_DIR="${INPUT_DIR:-/work/input}"
OUTPUT_DIR="${OUTPUT_DIR:-/work/output}"
EVALUATION_ID="${EVALUATION_ID:-womblex-pod}"
BUCKET="${REDLINE_BUCKET:-redline}"

echo ">> womblex pod: extracting corpus from $INPUT_DIR"
ls -1 "$INPUT_DIR" || { echo "FAIL: no input corpus mounted at $INPUT_DIR"; exit 1; }

mkdir -p "$OUTPUT_DIR"

# Extract every source document. `womblex extract -o <dir>` writes its shard set
# under <dir>/<run_id>/documents/ (the run id is womblex's, not ours), so we
# discover the shard directories after the fact rather than assuming a depth.
for doc in "$INPUT_DIR"/*; do
  [ -f "$doc" ] || continue
  name="$(basename "$doc")"
  echo ">> womblex extract: $name"
  womblex extract "$doc" -o "$OUTPUT_DIR/$name/"
done

# Chunk + (optionally) embed every shard directory womblex wrote. A shard dir is
# any directory containing *.elements.parquet.
shard_dirs() {
  find "$OUTPUT_DIR" -name '*.elements.parquet' -printf '%h\n' | sort -u
}

for dir in $(shard_dirs); do
  echo ">> womblex chunk: $dir"
  womblex chunk --shards "$dir/" || echo "   (chunk stage produced no chunks for $dir)"
done

# Embed stage (kanon-2-embedder) → *.embeddings.parquet siblings. Requires an
# Isaacus key; without it the retrieval sibling is absent (a womblex property, not
# a redline bug — the extraction/chunk shards still land).
if [ -n "${ISAACUS_API_KEY:-}" ]; then
  for dir in $(shard_dirs); do
    echo ">> womblex embed: $dir"
    womblex embed --shards "$dir/" || echo "   (embed stage failed for $dir)"
  done
else
  echo ">> ISAACUS_API_KEY unset — skipping embed stage; *.embeddings.parquet will be absent"
fi

echo ">> syncing shards to s3://$BUCKET/proc/$EVALUATION_ID/"
python3 - "$OUTPUT_DIR" "$EVALUATION_ID" <<'PY'
import glob, os, sys
from minio import Minio

output_dir, evaluation_id = sys.argv[1], sys.argv[2]
endpoint = os.environ["S3_ENDPOINT"].replace("http://", "").replace("https://", "")
secure = os.environ["S3_ENDPOINT"].startswith("https://")
bucket = os.environ.get("REDLINE_BUCKET", "redline")

client = Minio(
    endpoint,
    access_key=os.environ.get("S3_ACCESS_KEY", "minioadmin"),
    secret_key=os.environ.get("S3_SECRET_KEY", "minioadmin"),
    secure=secure,
)
if not client.bucket_exists(bucket):
    client.make_bucket(bucket)

count = 0
seen = {}
for path in sorted(glob.glob(os.path.join(output_dir, "**", "*.parquet"), recursive=True)):
    # Shard basenames (batch-NNNN.elements.parquet, …) can repeat across womblex
    # run directories; disambiguate with the parent dir name so nothing is
    # silently overwritten in the bucket.
    base = os.path.basename(path)
    if base in seen and seen[base] != path:
        parent = os.path.basename(os.path.dirname(path))
        key = f"proc/{evaluation_id}/{parent}--{base}"
    else:
        key = f"proc/{evaluation_id}/{base}"
    seen[base] = path
    client.fput_object(bucket, key, path)
    print(f"   put {key}")
    count += 1
if count == 0:
    print("FAIL: womblex produced no parquet shards", file=sys.stderr)
    sys.exit(1)
print(f">> synced {count} shard(s)")
PY

echo ">> womblex pod: done."
