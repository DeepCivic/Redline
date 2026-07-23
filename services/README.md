# services

Foreign-runtime sidecars, composed over runtime seams (HTTP/MCP + object storage),
never imported into the TypeScript packages.

- **`womblex-ingest/`** — womblex document-extraction sidecar (Thread 3). ready:
  FastAPI `POST /ingest` + `GET /status/{run_id}`, writes Parquet shards to MinIO
  under `proc/{evaluationId}/`. See [`womblex-ingest/README.md`](./womblex-ingest/README.md).
- **`numbatch/`** — Numbatch classification stack, forked + extended for
  configurable financial table extraction (Threads 5–7).

The `docker-compose.yml` that wires these with Postgres + MinIO lives under
[`../infra/`](../infra/docker-compose.yml), with compose profiles (`ingest`,
`numbatch`) so you bring up only what a thread needs. Per
[ADR-0002](../docs/adr/0002-own-minio-and-postgres.adr.md), redline owns its own
MinIO and Postgres.
