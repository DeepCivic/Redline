# womblex-ingest

womblex document-extraction sidecar for **redline** (build plan Thread 3). A thin
FastAPI wrapper around [womblex](../../docs/procurement-evaluation-plan.md#2-upstream-tools-corrected-understanding):
it runs extraction for an evaluation's documents and writes Parquet shards to
object storage under `proc/{evaluationId}/`.

Like Wayfinder's `services/australian-writing-mcp`, this is a **foreign-runtime
sidecar** composed over runtime seams (HTTP + object storage). It is never
imported into the TypeScript packages; the Thread 4 adapter
(`WomblexExtractionReader`) consumes its output over those seams as **JSON**.

## The Parquet→JSON boundary (Thread 4)

Build-plan §8 decision #2 is locked in favour of a **JSON seam**
([ADR-0003](../../docs/adr/0003-parquet-to-json-boundary.adr.md)): this sidecar
owns the heavy womblex/Parquet stack, reads its own shards, and serves a typed
JSON read model. The TypeScript adapter never links a Parquet reader. The one
place that understands womblex's schema is here (`records.py` +
`real_extractor.py`), where `source_hash` / `elem_order` / `chunk_id` / currency
cells are normalised into the camelCase wire shape the domain's
`IProcurementExtractionReader` DTOs mirror.

## HTTP surface

| Method & path        | Body / params                                  | Returns |
|----------------------|------------------------------------------------|---------|
| `GET /health`        | —                                              | `{ "status": "ok", "bucket": "redline" }` |
| `POST /ingest`       | `{ "evaluationId": string, "documentNames": string[] }` | `202 { runId, status, documentCount, shardKeys }` |
| `GET /status/{run_id}` | —                                            | `200 { runId, evaluationId, status, documentCount, shardKeys, error }` |
| `GET /extractions/{evaluationId}/{documentId}` | —                          | `200 { documentId, elements[], chunks[], tableCells[] }` |
| `GET /embeddings/{evaluationId}/{documentId}` | —                           | `200 { documentId, model, dimensions, vectors[] }` |

Errors cross the boundary Result-shaped — `{ "error": { "code", "message" } }` —
so the Thread 4 adapter maps them straight into a redline `DomainError`. Codes:
`INVALID_REQUEST` (422), `RUN_NOT_FOUND` (404), `NOT_FOUND` (404, unknown
extraction *or* unknown embeddings), `EXTRACTION_FAILED` (502).

Shards land under `proc/{evaluationId}/` in the `REDLINE_BUCKET` bucket, e.g.
`proc/eval-42/_manifest.parquet`, `proc/eval-42/tender.pdf.elements.parquet`. The
JSON read models are stored beside them as
`proc/{evaluationId}/{documentId}.extraction.json` and
`…​.embeddings.json`, so both read seams survive a sidecar restart (MinIO is the
durable record, per ADR-0002).

## The embeddings seam (Thread 19)

[ADR-0014](../../docs/adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md)
widens the JSON boundary to a second, **sibling** resource carrying womblex's
`*.embeddings.parquet` — one vector per chunk:

```json
{
  "documentId": "<source_hash>",
  "model": "stub-deterministic-v1",
  "dimensions": 8,
  "vectors": [{ "chunkId": "<source_hash>:0", "chunkIndex": 0, "values": [0.37, …] }]
}
```

- **A sibling, not a field on `/extractions`.** The embed stage is an optional
  overlay, so the two resources are absent **independently**: a document with no
  embed stage keeps serving its extraction while `GET /embeddings/...` returns
  `NOT_FOUND`. Folding vectors into the extraction would also make the Thread 4
  adapter pay megabytes for data it never reads.
- **`chunkId` is the join key** — `"{source_hash}:{chunk_index}"`, the same
  identity `ChunkRecord` carries — with `chunkIndex` repeating the ordinal so a
  consumer can join on `(source_hash, chunk_index)` without parsing the key.
- **Vectors cross L2-normalised**, so a consumer's cosine similarity is a dot
  product, and the payload **declares its `model`** — vectors from different
  models are incomparable, and a consumer matching topic definitions must embed
  them in the same space or refuse.
- `make_document_embeddings` in `records.py` is the only constructor, so those
  guarantees hold by construction rather than by convention.

Consumers should note the wire cost — a 768-dimension vector is ~15 kB as JSON
text against ~3 kB packed. The vectors are immutable and content-addressed, so
the Thread 20 adapter is expected to parse into `Float32Array` and cache per
evaluation rather than re-fetching per run.

## Extraction modes

`WOMBLEX_MODE` selects the extractor:

- **`stub`** (default) — deterministic, dependency-free shards. No womblex, no
  Isaacus. This is what the Thread 3 exit test and air-gapped runs use, and it
  keeps the image lightweight. It emits the shard *layout* womblex produces (a
  `_manifest` plus per-document shards) **and** the JSON read model the
  Parquet→JSON seam serves, so the Thread 4 adapter contract is provable offline.
- **`real`** — invokes the actual womblex pipeline. Requires an image built with
  `--build-arg INSTALL_WOMBLEX=1`. Isaacus enrichment is a further opt-in
  (`--build-arg ISAACUS=1` + `ISAACUS_API_KEY` at runtime); womblex also has
  non-Isaacus (edge/offline) modes. The Parquet→JSON mapping it must honour is
  pinned in `records.py`; the concrete womblex call surface is still pending, so
  `real` fails loudly until then.

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
python -m pytest -q            # 37 tests: HTTP surface, run lifecycle, both JSON read seams, stub extractor
```

Tests use in-memory fakes for both seams (object storage + womblex), so no MinIO
or womblex install is needed. The "shards actually land in MinIO" proof is the
compose-level smoke test above.
