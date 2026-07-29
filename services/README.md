# services

The two upstream engines, plus redline's own code that sits beside them. Composed
over runtime seams (HTTP + object storage), never imported into the TypeScript
packages.

**Upstream submodules** — byte-identical to their remotes, never modified
([ADR-0015](../docs/adr/0015-upstream-python-engines-are-submodules.adr.md)). Run
`git submodule update --init` on a fresh clone.

- **`womblex/`** — the womblex document-extraction engine, pinned to `v0.3.0`. Its
  own image and cloud runner (Postgres job queue + scalable `worker`, native S3
  staging) are what the `womblex` compose profile runs; redline supplies only
  configuration (`infra/womblex/redline.yaml`).
- **`numbatch/`** — the Numbatch classification fork (DeepCivic/Numbatch), pinned
  to `72bcead`. The `numbatch` compose profile builds its own
  `infra/docker/*.Dockerfile`s and runs **backend + Arq worker + inference**; the
  SvelteKit frontend is never started — redline owns its control surface
  ([ADR-0005](../docs/adr/0005-numbatch-fork-all-but-frontend.adr.md)).

**redline's own code**

- **`womblex-ingest/`** — the read seam: a lightweight FastAPI sidecar that reads
  the engine's Parquet shards from MinIO and serves JSON, so redline's TypeScript
  never links a Parquet reader
  ([ADR-0003](../docs/adr/0003-parquet-to-json-boundary.adr.md)). See
  [`womblex-ingest/README.md`](./womblex-ingest/README.md).
- **`numbatch-extension/`** — the additive overlay on the Numbatch fork: financial
  figures mapped to requirements (`financial_extension/`), and
  `bootstrap-profile.py`, which turns a `RequirementSet` into a trained profile
  over the API. A redline **requirement/criterion** maps to a Numbatch **topic**;
  an evaluation's requirement set maps to a **profile** (≤10). See
  [`numbatch-extension/README.md`](./numbatch-extension/README.md) and
  [ADR-0004](../docs/adr/0004-user-defined-requirements-not-fixed-1-6.adr.md).

The `docker-compose.yml` that wires these with Postgres + MinIO lives under
[`../infra/`](../infra/docker-compose.yml), with compose profiles (`ingest`,
`womblex`, `numbatch`, `redline`) so you bring up only what you need. Per
[ADR-0002](../docs/adr/0002-own-minio-and-postgres.adr.md), redline owns its own
MinIO and Postgres.
