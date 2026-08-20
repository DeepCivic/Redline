# services

redline's own Python, and nothing else. **There are no submodules** — Womblex is a
separate product with its own repo, reached over object storage, never carried in
this tree or imported into the TypeScript packages.

- **`womblex-ingest/`** — the read seam: a lightweight FastAPI sidecar that reads
  the Womblex engine's Parquet shards from object storage and serves them as JSON,
  so redline's TypeScript never links a Parquet reader. See
  [`womblex-ingest/README.md`](./womblex-ingest/README.md).

The Womblex schemas this sidecar maps are recorded in
[`docs/Womblex-Output-Contract.md`](../docs/Womblex-Output-Contract.md) — read
that rather than guessing column names, and rather than reaching for a checkout
of the engine.

The `docker-compose.yml` that wires the sidecar with MinIO and the MCP surface
lives under [`../infra/`](../infra/docker-compose.yml), with compose profiles
(`ingest`, `report`) so you bring up only what you need.
