# services

The upstream engine and the Wayfinder fork, plus redline's own Python that sits
beside them. Composed over runtime seams (HTTP + object storage), never imported
into the TypeScript packages.

**Submodules.** Run `git submodule update --init` on a fresh clone. The gitlink is
the only pin — no SHA or version is restated anywhere else, so bumping one is one
edit.

- **`womblex/`** — the womblex document-extraction engine, tracking its latest
  `main`. Byte-identical to its remote, never modified. Its own image and cloud
  runner (Postgres job queue + scalable `worker`, native S3 staging) are what the
  `womblex` compose profile runs; redline supplies only configuration
  (`infra/womblex/redline.yaml`).
- **`wayfinder/`** — the Wayfinder fork (johntooth/wayfinder), tracking branch
  `main`. Unlike womblex this is one redline *runs and edits*: its `apps/web`
  serves redline's Create Corpus surface and resolves `@redline/*` as workspace
  packages. The mount lives there only, never in redline's tree. `validate.sh`
  #12 keeps the checkout on the branch `.gitmodules` names.

**redline's own code**

- **`womblex-ingest/`** — the read and run seam: a lightweight FastAPI sidecar that
  reads the engine's Parquet shards from MinIO and serves JSON (so redline's
  TypeScript never links a Parquet reader), fires and tracks a run against the
  engine's queue, and loads the chunk / money-span / graph rows into redline's own
  Postgres. See [`womblex-ingest/README.md`](./womblex-ingest/README.md).

The `docker-compose.yml` that wires these with Postgres + MinIO lives under
[`../infra/`](../infra/docker-compose.yml), with compose profiles (`ingest`,
`money`, `womblex`, `stage`, `redline`) so you bring up only what you need.
redline owns its own MinIO and Postgres.
