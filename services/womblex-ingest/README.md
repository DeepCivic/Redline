# womblex-ingest

womblex document-extraction sidecar for **redline** (build plan Thread 3). A thin
FastAPI wrapper around [womblex](../../docs/procurement-evaluation-plan.md#2-upstream-tools-corrected-understanding):
it runs extraction for an evaluation's documents and writes Parquet shards to
object storage under `proc/{evaluationId}/`.

Like Wayfinder's `services/australian-writing-mcp`, this is a **foreign-runtime
sidecar** composed over runtime seams (HTTP + object storage). It is never
imported into the TypeScript packages; the Thread 4 adapter consumes its output
over those seams.

## HTTP surface

| Method & path        | Body / params                                  | Returns |
|----------------------|------------------------------------------------|---------|
| `GET /health`        | —                                              | `{ "status": "ok", "bucket": "redline" }` |
| `POST /ingest`       | `{ "evaluationId": string, "documentNames": string[] }` | `202 { runId, status, documentCount, shardKeys }` |
| `GET /status/{run_id}` | —                                            | `200 { runId, evaluationId, status, documentCount, shardKeys, error }` |

Errors cross the boundary Result-shaped — `{ "error": { "code", "message" } }` —
so the Thread 4 adapter maps them straight into a redline `DomainError`. Codes:
`INVALID_REQUEST` (422), `RUN_NOT_FOUND` (404), `EXTRACTION_FAILED` (502).

Shards land under `proc/{evaluationId}/` in the `REDLINE_BUCKET` bucket, e.g.
`proc/eval-42/_manifest.parquet`, `proc/eval-42/tender.pdf.elements.parquet`.

## Extraction modes

`WOMBLEX_MODE` selects the extractor:

- **`stub`** (default) — deterministic, dependency-free shards. No womblex, no
  Isaacus. This is what the Thread 3 exit test and air-gapped runs use, and it
  keeps the image lightweight. It emits the shard *layout* womblex produces (a
  `_manifest` plus per-document shards); the real Parquet *schema* is pinned in
  Thread 4.
- **`real`** — invokes the actual womblex pipeline. Requires an image built with
  `--build-arg INSTALL_WOMBLEX=1`. Isaacus enrichment is a further opt-in
  (`--build-arg ISAACUS=1` + `ISAACUS_API_KEY` at runtime); womblex also has
  non-Isaacus (edge/offline) modes. The concrete womblex call surface is finished
  alongside the Thread 4 Parquet boundary — until then `real` fails loudly.

## Configuration

All from the environment (per [ADR-0002](../../docs/adr/0002-own-minio-and-postgres.adr.md),
the S3 target is fully config-driven — never a hardcoded Wayfinder endpoint):

| Var | Default | Meaning |
|-----|---------|---------|
| `S3_ENDPOINT`   | `http://minio:9000` | MinIO/S3 endpoint |
| `S3_ACCESS_KEY` | `minioadmin` | S3 access key |
| `S3_SECRET_KEY` | `minioadmin` | S3 secret key |
| `REDLINE_BUCKET`| `redline`    | bucket for shards (created on first use) |
| `WOMBLEX_MODE`  | `stub`       | `stub` \| `real` |
| `ISAACUS_API_KEY` | _(unset)_  | only used by `real` mode with an Isaacus-enabled image |

## Run

Via the redline compose stack (`ingest` profile brings up MinIO + this service):

```sh
podman compose -f ../../infra/docker-compose.yml --profile ingest up -d
# exit-test smoke check (compose up → POST docs → assert shards in MinIO):
../../scripts/thread-03-smoke.sh
podman compose -f ../../infra/docker-compose.yml --profile ingest down -v
```

## Develop / test

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
python -m pytest -q            # 12 tests: HTTP surface, run lifecycle, stub extractor
```

Tests use in-memory fakes for both seams (object storage + womblex), so no MinIO
or womblex install is needed. The "shards actually land in MinIO" proof is the
compose-level smoke test above.
