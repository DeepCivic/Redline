# services

Foreign-runtime sidecars, composed over runtime seams (HTTP/MCP + object storage),
never imported into the TypeScript packages.

- **`womblex-ingest/`** — womblex document-extraction sidecar (Thread 3). ready:
  FastAPI `POST /ingest` + `GET /status/{run_id}`, writes Parquet shards to MinIO
  under `proc/{evaluationId}/`. See [`womblex-ingest/README.md`](./womblex-ingest/README.md).
- **`numbatch/`** — Numbatch **fork** (DeepCivic/Numbatch), scaffolded (Thread 5). We run
  its **backend + Arq worker + inference service** (SvelteKit frontend excluded — redline
  owns its own control surface + review grid) and **extend the backend** for financial
  figures mapped to requirements (Threads 6–7). A redline **requirement/criterion** maps to
  a Numbatch **topic**; an evaluation's requirement set maps to a Numbatch **profile** (≤10).
  The `bootstrap-profile.py` script turns a `RequirementSet` into a trained profile over
  the API. See [`numbatch/README.md`](./numbatch/README.md),
  [ADR-0004](../docs/adr/0004-user-defined-requirements-not-fixed-1-6.adr.md), and
  [ADR-0005](../docs/adr/0005-numbatch-fork-all-but-frontend.adr.md).

The `docker-compose.yml` that wires these with Postgres + MinIO lives under
[`../infra/`](../infra/docker-compose.yml), with compose profiles (`ingest`,
`numbatch`) so you bring up only what a thread needs. Per
[ADR-0002](../docs/adr/0002-own-minio-and-postgres.adr.md), redline owns its own
MinIO and Postgres.
