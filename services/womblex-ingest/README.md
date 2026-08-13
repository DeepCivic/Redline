# womblex-ingest

womblex document-extraction sidecar for **redline**. A thin FastAPI wrapper
around [womblex](../../docs/architecture.md) (the engine is pinned as a git
submodule at `services/womblex`): it serves the Parquet shards womblex produced
for an evaluation's documents as JSON, under `proc/{evaluationId}/`.

Like Wayfinder's `services/australian-writing-mcp`, this is a **foreign-runtime
sidecar** composed over runtime seams (HTTP + object storage). It is never
imported into the TypeScript packages; the extraction-reader adapter
(`WomblexExtractionReader`) consumes its output over those seams as **JSON**.

> **Isaacus is required for retrieval; air-gap is a non-goal.** womblex's embed
> stage (`kanon-2-embedder`) is Isaacus-only, so `*.embeddings.parquet` — and
> therefore redline's cold-start retrieval — needs a live `ISAACUS_API_KEY`.
> Extraction and chunking run offline; retrieval does not. See
> ADR-0008
> (amended) and [`docs/architecture.md`](../../docs/architecture.md).

## The Parquet→JSON boundary

The boundary is a **JSON seam**
(ADR-0003): this sidecar
owns the heavy womblex/Parquet stack, reads its own shards, and serves a typed
JSON read model. The TypeScript adapter never links a Parquet reader. The one
place that understands womblex's schema is here (`records.py` +
`real_extractor.py` + `shard_reader.py`), where `source_hash` / `elem_order` /
`chunk_index` / `value_type` cells are normalised into the camelCase wire shape
the domain's `IProcurementExtractionReader` DTOs mirror.

## HTTP surface

| Method & path        | Body / params                                  | Returns |
|----------------------|------------------------------------------------|---------|
| `GET /health`        | —                                              | `{ "status": "ok", "bucket": "redline", "womblexMode" }` |
| `POST /ingest`       | `{ "evaluationId": string, "documentNames": string[] }` | `202 { runId, status, documentCount, shardKeys }` |
| `GET /status/{run_id}` | —                                            | `200 { runId, evaluationId, status, documentCount, shardKeys, error }` |
| `POST /runs`         | `{ "evaluationId": string, "stageSequence": string[] }` | `202 { runId, evaluationId }` |
| `GET /runs/{run_id}` | —                                              | `200 { runId, evaluationId, phase, completedStages[], failedStage, resumable, error }` |
| `POST /runs/{run_id}/resume` | —                                      | `202 { runId, evaluationId }` |
| `GET /extractions/{evaluationId}/{documentId}` | —                          | `200 { documentId, elements[], chunks[], tableCells[] }` |
| `GET /embeddings/{evaluationId}/{documentId}` | —                           | `200 { documentId, model, dimensions, vectors[] }` |
| `POST /embeddings/query` | `{ "text": string }`                              | `200 { model, dimensions, values[] }` |

Errors cross the boundary Result-shaped — `{ "error": { "code", "message" } }` —
so the Thread 4 adapter maps them straight into a redline `DomainError`. Codes:
`INVALID_REQUEST` (422, empty ingest field, blank query text, *or* an off-list
stage in a run request), `RUN_NOT_FOUND` (404), `NOT_FOUND` (404, unknown
extraction *or* unknown embeddings), `EXTRACTION_FAILED` (502), `INFRA_FAILURE`
(503 when the run trigger is not configured).

Shards land under `proc/{evaluationId}/` in the `REDLINE_BUCKET` bucket, e.g.
`proc/eval-42/_manifest.parquet`, `proc/eval-42/tender.pdf.elements.parquet`. The
JSON read models are stored beside them as
`proc/{evaluationId}/{documentId}.extraction.json` and
`…​.embeddings.json`, so both read seams survive a sidecar restart (MinIO is the
durable record, per ADR-0002).

## The embeddings seam

ADR-0014
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

## The text-embedding query seam

Retrieval matches a topic *definition* against the chunk vectors, and redline's
TypeScript links no embedding model — so the sidecar embeds query text too, in
the **same space** as the chunk vectors:

```
POST /embeddings/query
  { "text": "network security controls" }
  → 200 { "model": "stub-deterministic-v1", "dimensions": 8, "values": [0.51, …] }
  → 422 { "error": { "code": "INVALID_REQUEST", … } }   # blank text
```

- **Same `model` and `dimensions` as the document vectors**, L2-normalised the
  same way — a query·chunk dot product is well-formed only then. A consumer can
  (and should) confirm the declared model matches before ranking.
- **Chunk-free and evaluation-independent.** A query carries no `chunkId` and is
  never persisted — a definition is embedded before a corpus is even mapped.
- **Deterministic (stub).** The stub embeds the same (whitespace-trimmed) text to
  the same vector, so a captured fixture is stable. `make_query_embedding` in
  `records.py` is the only constructor; `StubTextEmbedder` (`embedding.py`) shares
  the stub extractor's hashing scheme so queries and chunks share one space.
- **Real mode is wired**, reading the same shards the pod produced:
  `RealWomblexTextEmbedder` embeds query text via womblex's Isaacus embed op with
  task `retrieval/query`, declaring the same `kanon-2-embedder` model the chunk
  vectors use so the two are comparable.

Consumers should note the wire cost — a 768-dimension vector is ~15 kB as JSON
text against ~3 kB packed. The vectors are immutable and content-addressed, so
the Thread 20 adapter is expected to parse into `Float32Array` and cache per
evaluation rather than re-fetching per run.

## The money annotation step

Pricing recovery is womblex's own `money` op, not a redline reimplementation.
After a run's shards land, `womblex money` reads each batch's
`*.elements.parquet` + `*.table_cells.parquet` and writes two siblings —
`*.money_spans.parquet` (one row per amount, exact `Decimal`, with its currency)
and `*.money_columns.parquet` (the per-column verdict audit). It is offline and
API-free (no Isaacus spend), and it never rewrites element or chunk text.

Because `womblex money --shards` only takes a *local* directory but the shards
live in object storage, `money_stage.py` is the stage-in / run / stage-out / load
step that bridges the gap (mirroring `womblex finalize`): it downloads an
evaluation's money inputs to a scratch dir, runs womblex's `money_shards()`,
publishes the two sidecars back under `proc/{evaluationId}/documents/`, and loads
the spans into `redline_money_spans` off the same scratch dir. Run it on demand
once a run has drained, via the `money` compose profile:

```sh
podman compose -f ../../infra/docker-compose.yml --profile money \
  run --rm money --evaluation-id <evaluationId>
```

The engine's own generic `run-stage --stage money` (the `stage` profile) shares
the *compute* but stops at publishing the sidecars — it has no equivalent of the
`redline_money_spans` load, which is redline's. That load is why `money_stage.py`
is kept rather than replaced by the generic stage runner.

The `money:` section (vocabulary, vetoes, currency default) is read from the same
`infra/womblex/redline.yaml` the worker runs with (`WOMBLEX_CONFIG`), so the
tuning is never restated. The `money` image is built from the repo root by
`infra/docker/womblex-money.Dockerfile`, which installs the engine from the
`services/womblex` submodule source — the `[womblex]` extra's pin is an untagged
commit not on any index, so it cannot be pip-installed. The read seam above keeps
its own light, womblex-free `sidecar` Dockerfile.

The load is the step that makes the annotation worth running:
`money_span_store.py` decodes each `*.money_spans.parquet` and
`money_span_store_postgres.py` writes it to `redline_money_spans`, which the
TypeScript `IMoneySpanStore` then reads — no Parquet ever crosses into
TypeScript. The span lands **uninterpreted**: womblex's own 24 columns, all three
loci (`narrative` / `table_cell` / `sheet_cell`, exactly one anchor group non-null
per row), the qualifiers it refuses to fold into `value` (`modifier`,
`multiplier`, `negative`) and the `range_group` / `range_role` pairing of a
range's endpoints. Deciding what a span *means* belongs above the store.
`redline_money_spans` is created by redline-adapters' migrations (it holds a
foreign key to `redline_evaluations`), so this service carries no DDL for it and
the load needs an already-migrated database. Without `REDLINE_DATABASE_URL` the
sidecars are still published and the load is skipped.

## The run-trigger seam

redline's **second seam to the womblex engine** (the first is object storage —
the engine writes shards, the sidecar reads them). `run_trigger.py` triggers a
run into the engine's job queue and reads its state, so a browser starts and
watches a run without a terminal driving `enqueue` / `worker` / `run-stage` by
hand. The TypeScript `IWomblexRunTrigger` / `HttpWomblexRunTrigger` adapter
consumes the three `/runs` routes above.

`RunTrigger` is a **thin runner**, not an orchestrator. `start` fires the fixed
CLI sequence the operator otherwise fires by hand:

1. extraction — `enqueue` the evaluation's staged inputs, then run a `worker`
   until the run drains;
2. the authored downstream stages — `run-stage --stage {chunk,embed,enrich,money}`
   in the caller's order;
3. the load — project the run's published shards into `redline_chunks` (the same
   projection `POST /ingest` drives), so the corpus the run just produced is
   visible to the evaluation screen with no `POST /ingest` in between. Without
   this a browser-fired run would leave shards no screen can see — the two-screen
   flow has no join without it. It runs only after every stage completed (loading
   a half-run would land a partial corpus), and a load failure fails the run
   loudly rather than leaving a done run whose corpus never reached the store.

The allow-listed stage **sequence** is authored per request (the Create Corpus
surface's override over `redline.yaml`); the **dependency** (chunk before embed)
is enforced here (`normalise_sequence`), not left to the specialist. Only
`chunk` / `embed` / `enrich` / `money` are authorable — the structural stages
(`link`, `pii`, …) are not run parameters, and a request naming one is refused
with `INVALID_REQUEST` (see `design-principles.md`, the engine-config allow-list).

redline does **not** reimplement batching, retry or scale-out — those stay the
engine's (`cloud/worker.py`, its Postgres `womblex_jobs` queue). The status read
layers the current downstream stage on top of the queue's own extraction stats
(`womblex_jobs` tracks extraction batches only). **Resume is not its own logic:**
womblex's `enqueue` is idempotent on `(run_id, batch_num)` and completed
`run-stage` bases skip on their published outputs, so re-firing the same run picks
up where it stopped.

Run state is in-memory and process-local (like the ingest `RunRegistry`): a run's
durable record is its shards in MinIO and its `womblex_jobs` rows. The trigger is
wired only when the engine's queue DSN + store URI are configured
(`WOMBLEX_DB_DSN`, `WOMBLEX_STORE_URI`); absent, the sidecar is a read-only seam
and the `/runs` routes return `503`. The five engine operations (the four queue /
stage passes plus the load projection) are injected callables, so the sequencing
logic is proven without a live Postgres, a real womblex or an Isaacus key
(`tests/test_run_trigger.py`); `run_trigger_from_env` binds them to the real
engine (womblex imported lazily, real lane only). The load binding reuses the
same `RealWomblexExtractor` read + `chunk_store.load_extraction` projection
`POST /ingest` runs, so an ingest and a run land identical rows; it is a no-op
without `REDLINE_DATABASE_URL`, the same skip `POST /ingest` takes.

## Extraction modes & the womblex pod

**womblex is a required subsystem of redline**, not an optional extra: the
retrieval leg *is* womblex's `*.embeddings.parquet`. redline runs it from the
engine's **own image** — the one the engine itself ships, built from the
`services/womblex` submodule by the `womblex` compose service and driven through
the engine's own `enqueue` / `worker` cloud runner. Running it as its own image
is a **deployment choice** for resource/lifecycle isolation, not a hard
requirement: the sidecar image is `python:3.12-slim` (inside womblex's 3.11/3.12
support), so the engine can equally be co-located with the sidecar on one host.
Either way the seam is object storage (ADR-0002), and what backs it — an S3
bucket or an AWS-managed equivalent — is config. The engine source is pinned as a
submodule at `services/womblex` (an untagged `main` commit ahead of `v0.3.0`,
declaring version `0.4.0`; the sidecar's `[womblex]` pin tracks it — see
`docs/architecture.md`, "Vendoring / pinning discipline").

`WOMBLEX_MODE` selects which extractor this API sidecar uses:

| `WOMBLEX_MODE` | Reads | Retrieval available? |
|---|---|---|
| `real` (redline's deployment) | the womblex pod's Parquet shards from MinIO | yes, when the pod embedded with a live `ISAACUS_API_KEY` |
| `stub` (**test double**) | nothing — emits deterministic shards + JSON | no (deterministic non-semantic vectors, CI only) |

- **`real`** — this API sidecar reads the Parquet shards the **womblex pod**
  produced (extract → chunk → embed) from MinIO and serves them as JSON. This is
  what redline's deployment runs. The embed stage (`kanon-2-embedder`) is
  Isaacus-only, so `*.embeddings.parquet` — and therefore retrieval — requires
  `ISAACUS_API_KEY` at pod run time. Without it the pod still lands the
  extraction + chunk shards, and `GET /embeddings/...` returns `NOT_FOUND`.
- **`stub`** — the dependency-free **test double**. Deterministic shards with no
  womblex/Isaacus install, so the extraction-reader contract and the HTTP +
  storage behaviour are provable in CI without the engine. It emits the shard
  *layout* womblex produces plus the JSON read model the seam serves. **It is a
  test double, not a shipping mode** — redline's deployment always includes the
  real womblex pod.

### The womblex pod

The real engine runs as its own container. Bring it up over a document set and it
lands real Parquet shards in MinIO under `proc/{evaluationId}/`:

```sh
# extract → chunk → embed a corpus into the shared bucket:
ISAACUS_API_KEY=… WOMBLEX_EVAL_ID=my-eval scripts/womblex-pod.sh
# with a real document set:
ISAACUS_API_KEY=… WOMBLEX_CORPUS=/path/to/docs scripts/womblex-pod.sh
```

`*.embeddings.parquet` (the retrieval sibling) is produced by `kanon-2-embedder`
and so needs `ISAACUS_API_KEY` set; without a key the extraction + chunk shards
still land, but there is no retrieval.

## Configuration

All from the environment (per ADR-0002,
the S3 target is fully config-driven — never a hardcoded Wayfinder endpoint):

| Var | Default | Meaning |
|-----|---------|---------|
| `S3_ENDPOINT`   | `http://minio:9000` | MinIO/S3 endpoint |
| `S3_ACCESS_KEY` | `minioadmin` | S3 access key |
| `S3_SECRET_KEY` | `minioadmin` | S3 secret key |
| `REDLINE_BUCKET`| `redline`    | bucket for shards (created on first use) |
| `WOMBLEX_MODE`  | `stub`       | `stub` \| `real` |
| `ISAACUS_API_KEY` | _(unset)_  | consumed by the **womblex pod** for the embed stage (`kanon-2-embedder`); required for retrieval |
| `REDLINE_DATABASE_URL` | _(unset)_ | redline's own Postgres; when set, an ingest projects chunks + embeddings into `redline_chunks` and the money load writes `redline_money_spans` |
| `WOMBLEX_DB_DSN` | _(unset)_ | the engine's `womblex_jobs` queue DSN; with `WOMBLEX_STORE_URI`, wires the run trigger (else `/runs` is `503`) |
| `WOMBLEX_STORE_URI` | _(unset)_ | the engine's object-store base URI (e.g. `s3://redline`); the run trigger's `enqueue` / `worker` / `run-stage` target |

## Run

Via the redline compose stack (`ingest` profile brings up MinIO + this service):

```sh
podman compose -f ../../infra/docker-compose.yml --profile ingest up -d
# smoke check (compose up → POST docs → assert shards in MinIO):
../../scripts/womblex-smoke.sh
podman compose -f ../../infra/docker-compose.yml --profile ingest down -v
```

## Develop / test

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
python -m pytest -q            # HTTP surface, run lifecycle, both JSON read seams, stub extractor, schema mapping
```

Tests use in-memory fakes for both seams (object storage + womblex), so no MinIO
or womblex install is needed. The stub-only lane above stays fast and
dependency-free.

The **real binding** reads the womblex pod's Parquet shards and maps them to the
JSON read model. Its schema mapping (`shard_reader.py`) is proven on plain row
dicts in that same lane (`tests/test_shard_reader.py`), and the read +
Parquet-decode path is proven against **real Parquet** — written into the
in-memory store, decoded by the same pyarrow the binding uses — in a
pyarrow-gated lane (`tests/test_real_extractor.py`, skipped unless the `womblex`
extra is installed):

```sh
pip install -e '.[dev,womblex]'   # adds pyarrow (real lane) + the womblex engine pin
python -m pytest -q                # now also runs the real-extractor lane
```

The womblex **engine** can run from its own image (resource/lifecycle isolation,
its own cloud runner for scale-out) or co-located with the sidecar — the split is
a deployment choice, not a constraint: the sidecar image is `python:3.12-slim`,
inside womblex's own 3.11/3.12 support, so `.[womblex]` installs cleanly here. The
`importorskip` in `tests/test_real_extractor.py` guards only against a
`validate.sh` box on a *newer* interpreter (e.g. 3.13, which the OCR wheel does
not cover) or one that simply did not install the extra. The
engine-produced-shards proof (real corpus → real engine → these reads) is still
the compose-level smoke, exactly as the "shards actually land in MinIO" proof is.
