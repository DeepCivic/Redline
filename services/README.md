# services

Foreign-runtime sidecars, composed over runtime seams (HTTP/MCP + object storage),
never imported into the TypeScript packages.

- **`womblex-ingest/`** — womblex document-extraction sidecar (Thread 3).
- **`numbatch/`** — Numbatch classification stack, forked + extended for
  configurable financial table extraction (Threads 5–7).

The `docker-compose.yml` that wires these with Postgres + MinIO lands under
`infra/` alongside them.
