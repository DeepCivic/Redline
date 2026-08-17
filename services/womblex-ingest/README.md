# womblex-ingest

womblex document-extraction sidecar for **redline**. A thin FastAPI wrapper
around the **womblex** engine (pinned as a git submodule at
`services/womblex`): it serves the Parquet shards womblex produced for a
corpus's documents as JSON, under `proc/{evaluationId}/`.

Like Wayfinder's `services/australian-writing-mcp`, this is a **foreign-runtime
sidecar** composed over runtime seams (HTTP + object storage). It is never
imported into the TypeScript packages; the extraction-reader adapter
(`WomblexExtractionReader`) consumes its output over those seams as **JSON**.

## The Parquet→JSON boundary

The boundary is a **JSON seam**: this sidecar owns the heavy womblex/Parquet
stack, reads its own shards, and serves a typed JSON read model. The
TypeScript adapter never links a Parquet reader. The one place that
understands womblex's schema is here (`records.py` + `real_extractor.py` +
`shard_reader.py`), where `source_hash` / `elem_order` / `chunk_index` /
`value_type` cells are normalised into the camelCase wire shape the domain's
`IProcurementExtractionReader` DTOs mirror.

## HTTP surface

| Method & path        | Body / params                                  | Returns |
|----------------------|------------------------------------------------|---------|
| `GET /health`        | —                                              | `{ "status": "ok", "bucket": "redline", "womblexMode", "isaacusEnabled" }` |
| `POST /ingest`       | `{ "evaluationId": string, "documentNames": string[], "runId"?: string }` | `202 { runId, status, documentCount, shardKeys }` |
| `GET /status/{run_id}` | —                                            | `200 { runId, evaluationId, status, documentCount, shardKeys, error }` |
| `GET /extractions/{evaluationId}/{documentId}` | —                          | `200 { documentId, elements[], chunks[], tableCells[] }` |

Errors cross the boundary Result-shaped — `{ "error": { "code", "message" } }` —
so the TypeScript adapter maps them straight into a redline `DomainError`.
Codes: `INVALID_REQUEST` (422, empty ingest field), `RUN_NOT_FOUND` (404),
`NOT_FOUND` (404, unknown extraction), `EXTRACTION_FAILED` (502).

Shards land under `proc/{evaluationId}/` in the `REDLINE_BUCKET` bucket, e.g.
`proc/eval-42/_manifest.parquet`, `proc/eval-42/tender.pdf.elements.parquet`.
The JSON read model is stored beside them as
`proc/{evaluationId}/{documentId}.extraction.json`, so the read seam survives
a sidecar restart (MinIO is the durable record).

**Known gap:** a corpus run twice serves every document twice today —
`RealWomblexExtractor.extract` lists the whole `proc/{evaluationId}/` prefix
and concatenates by suffix, merging every run under it. Every route this
sidecar adds for the report engine (documents, chunks, graph, money spans)
must be run-scoped, and this route needs the same fix — see
`docs/Redline-Plan.md` §8 blocker 1.

## Extraction modes & the womblex pod

**womblex is a required subsystem of redline**, not an optional extra: it is
the only source of the chunks, graph edges and money spans a report run reads.
redline runs it from the engine's **own image** — the one the engine itself
ships, built from the `services/womblex` submodule by the `womblex` compose
service and driven through the engine's own `enqueue` / `worker` cloud runner.
Running it as its own image is a **deployment choice** for resource/lifecycle
isolation, not a hard requirement: the sidecar image is `python:3.12-slim`
(inside womblex's 3.11/3.12 support), so the engine can equally be co-located
with the sidecar on one host. Either way the seam is object storage, and what
backs it — an S3 bucket or an AWS-managed equivalent — is config.

`WOMBLEX_MODE` selects which extractor this API sidecar uses:

| `WOMBLEX_MODE` | Reads | Retrieval available? |
|---|---|---|
| `real` (redline's deployment) | the womblex pod's Parquet shards from MinIO | yes, when the pod embedded with a live `ISAACUS_API_KEY` |
| `stub` (**test double**) | nothing — emits deterministic shards + JSON | no (deterministic non-semantic vectors, CI only) |

- **`real`** — this API sidecar reads the Parquet shards the **womblex pod**
  produced (extract → chunk → embed) from MinIO and serves them as JSON. This
  is what redline's deployment runs. The embed stage (`kanon-2-embedder`) is
  Isaacus-only, so `*.embeddings.parquet` — and therefore retrieval — requires
  `ISAACUS_API_KEY` at pod run time.
- **`stub`** — the dependency-free **test double**. Deterministic shards with
  no womblex/Isaacus install, so the extraction-reader contract and the HTTP +
  storage behaviour are provable in CI without the engine. It emits the shard
  *layout* womblex produces plus the JSON read model the seam serves. **It is
  a test double, not a shipping mode** — redline's deployment always includes
  the real womblex pod.

Downstream stages (`chunk` / `embed` / `enrich` / `money`) run separately, on
demand, via the engine's own `run-stage` (the `stage` compose profile) — they
are not driven from this sidecar.

## Configuration

All from the environment — the S3 target is fully config-driven, never a
hardcoded Wayfinder endpoint:

| Var | Default | Meaning |
|-----|---------|---------|
| `S3_ENDPOINT`   | `http://minio:9000` | MinIO/S3 endpoint |
| `S3_ACCESS_KEY` | `minioadmin` | S3 access key |
| `S3_SECRET_KEY` | `minioadmin` | S3 secret key |
| `REDLINE_BUCKET`| `redline`    | bucket for shards (created on first use) |
| `WOMBLEX_MODE`  | `stub`       | `stub` \| `real` |
| `ISAACUS_API_KEY` | _(unset)_  | consumed by the **womblex pod** for the embed stage (`kanon-2-embedder`); required for retrieval |

## Run

Via the redline compose stack (`ingest` profile brings up MinIO + this service):

```sh
podman compose -f ../../infra/docker-compose.yml --profile ingest up -d
# smoke check (compose up → POST docs → assert shards in MinIO):
../../scripts/thread-03-smoke.sh
podman compose -f ../../infra/docker-compose.yml --profile ingest down -v
```

## Develop / test

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
python -m pytest -q            # HTTP surface, run lifecycle, JSON read seam, stub extractor, schema mapping
```

Tests use in-memory fakes for both seams (object storage + womblex), so no
MinIO or womblex install is needed. The stub-only lane above stays fast and
dependency-free.

The **real binding** reads the womblex pod's Parquet shards and maps them to
the JSON read model. Its schema mapping (`shard_reader.py`) is proven on plain
row dicts in that same lane (`tests/test_shard_reader.py`), and the read +
Parquet-decode path is proven against **real Parquet** — written into the
in-memory store, decoded by the same pyarrow the binding uses — in a
pyarrow-gated lane (`tests/test_real_extractor.py`, skipped unless the
`womblex` extra is installed):

```sh
pip install -e '.[dev,womblex]'   # adds pyarrow (real lane) + the womblex engine pin
python -m pytest -q                # now also runs the real-extractor lane
```

The womblex **engine** can run from its own image (resource/lifecycle
isolation, its own cloud runner for scale-out) or co-located with the sidecar
— the split is a deployment choice, not a constraint: the sidecar image is
`python:3.12-slim`, inside womblex's own 3.11/3.12 support, so `.[womblex]`
installs cleanly here. The `importorskip` in `tests/test_real_extractor.py`
guards only against a `validate.sh` box on a *newer* interpreter (e.g. 3.13,
which the OCR wheel does not cover) or one that simply did not install the
extra.
