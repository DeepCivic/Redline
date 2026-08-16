# Running both stacks locally

redline's UI is served by the **forked Wayfinder** (`services/wayfinder`), not by
a standalone shell. So a working local environment is two stacks side by side:
redline's own services, and the fork's web app pointed at them. This is the
runbook for that.

The fork's `apps/web` runs **on the host** (`pnpm dev`), not in a container —
its `docker-compose.yml` provides infrastructure only. That is why there is no
web service in redline's compose file and no combined profile: the two stacks
meet over configuration, not over a shared network namespace.

---

## 1. redline's services

From the repository root. UAT runs this on Podman; `docker compose` is
interchangeable everywhere below.

```bash
podman compose -f infra/docker-compose.yml --profile ingest up -d
```

That brings up `redline-postgres`, `minio` and the `womblex-ingest` sidecar.

**Export `WOMBLEX_MODE=real` first.** The compose default is `stub` — a
dependency-free test double that serves deterministic fabricated shards. It is
there for CI, and a UAT run left on it will look like it succeeded while showing
invented documents. Confirm which lane you are on before trusting anything:

```bash
curl -s localhost:8000/health   # {"womblexMode":"real", ...}
```
Apply redline's migrations against the database once it is accepting
connections — `applyMigrations` is driver-agnostic and the production path runs
it through the `postgres` client:

```bash
DATABASE_URL=postgresql://redline:redline-dev@localhost:5433/redline \
  pnpm --filter @redline/redline-adapters db:migrate
```

The migration is idempotent, so re-running it is a no-op.

Confirm the sidecar answers before moving on: it is the extraction seam the
report tools read through, and the run trigger the Create Corpus screen fires.

## 2. The fork's infrastructure

The fork keeps its **own** Postgres, MinIO and Langfuse — redline never shares
Wayfinder's database:

```bash
cd services/wayfinder
docker compose up -d
```

## 3. The fork's web app

```bash
cd services/wayfinder
cp .env.example .env     # then fill in the values below
pnpm install
pnpm dev
```

The redline block at the end of `.env.example` is what wires the mount:

| Variable | What it points at |
|---|---|
| `REDLINE_DATABASE_URL` | redline's Postgres from step 1 — **never** Wayfinder's `DATABASE_URL` |
| `REDLINE_WOMBLEX_INGEST_URL` | the sidecar from step 1 (default `http://localhost:8000`) |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `REDLINE_BUCKET` | redline's object store, which the Create Corpus screen stages uploads into |

**Leaving `REDLINE_DATABASE_URL` blank is a supported state.** The fork then
boots as plain Wayfinder with the `/create-corpus` route unavailable, rather than
failing its fail-fast env parse. `resolveRedlineModule` returns `null` and
nothing else in the container notices.

`pnpm install` here runs `onnxruntime-node`'s postinstall, which downloads a
native binary. On a restricted network it fails the whole install; the fork's own
infrastructure does not need it, so `pnpm install --config.ignore-scripts=true`
gets you a working web app when that download is blocked.

---

## 4. A corpus

Run the engine over the corpus. The shards it lands are what everything
downstream reads. The Create Corpus screen does this from the browser; the
terminal path below is the way to de-risk a run without one:

```bash
KEEP_UP=1 \
WOMBLEX_EVAL_ID=cloud-rft-2026 \
WOMBLEX_CORPUS=services/womblex-ingest/tests/corpus-local \
  scripts/womblex-engine-smoke.sh
```

Both environment variables are load-bearing, and neither is the script's default:

- **`WOMBLEX_EVAL_ID` is the corpus id.** The sidecar reads shards from
  `proc/{corpusId}/` and `real_extractor.extract` ignores the document names it is
  handed — it returns whatever is under that prefix. A run under any other id is
  invisible to every read.
- **`KEEP_UP=1`, or the run destroys its own output.** The script's cleanup is
  `compose down -v`, which removes the MinIO volume along with the containers.

The default (`smoke-<timestamp>`, torn down at exit) is right for proving the
engine works and wrong for every real corpus.

### What that one command actually runs

`womblex run`/`worker` persists **extraction only**. It computes chunking when
`chunking.enabled` and then throws it away — `write_batch_parquet` hands
`write_results` just `(doc_id, path, extraction)`, and chunks hang off
`result.chunks`. Every downstream layer is a separate pass, which is what the
script's `run-stage` loop does:

```
worker → chunk → embed → enrich → money
```

Four things about that order are not obvious from the config:

- **Chunk before embed, and chunk before enrich.** Ordering between stages is
  the caller's; nothing enforces it.
- **Enrich after chunk is load-bearing but silent.** Chunks are a *non-strict*
  input to enrich, so enrich-first still succeeds — and lands every entity with
  `chunk_index = -1`, a graph that cannot be joined to chunk text.
- **Money is independent.** It reads the *element* shards, not enrich's, so it
  needs no config change and no predecessor beyond the worker.
- **The `run` pass does chunking twice unless you turn it off.** Setting
  `chunking.enabled: false` avoids the wasted work and is safe for `run-stage`,
  which ignores the flag — but `womblex chunk --config` **refuses outright**
  when it is false, so do not flip it if anyone uses that composition. The waste
  is CPU and wall clock, not Isaacus spend: redline sets no `chunking_model`, so
  chunking is local semchunk over a vendored tokeniser.

## What you can and cannot reach

Once both stacks are up, **Create Corpus** is linked from the sidebar and
`/create-corpus` is served, gated on the `corpus:create` permission, which is
seeded to a specialist role, so an ordinary non-admin test account can reach it.
From there a specialist names a run, uploads its documents, authors the config
and watches the run drain.

What the run lands is read through `apps/redline-mcp`'s report tools rather than
through a screen — bring the `report` compose profile up and register the server
in Wayfinder to reach them.

## Isaacus

The three gated stages differ, and the difference decides whether you need an
account.

- **`chunk` is gated by policy, not capability.** `chunk_shards` returns early
  when `isaacus_available()` is false — a network-free check for **both** the
  `isaacus` package being importable **and** a non-empty `ISAACUS_API_KEY`. With
  no `chunking_model` set (redline's profile sets none), `create_chunker`
  resolves the Kanon-2 tokeniser from womblex's vendored copy at
  `_models/kanon-2-tokenizer/` and makes no API call. So any non-empty string
  satisfies the key half: `ISAACUS_API_KEY=uat-local` produces chunks offline.

  The package half is why redline's compose builds the engine image with
  `EXTRAS: cloud,isaacus`. The engine's own Dockerfile defaults to `EXTRAS=cloud`,
  which omits the SDK — and an engine without it skips chunking silently, landing
  extraction shards and nothing else regardless of the key.
  Under `run-stage` the policy gate **fails the stage loudly** rather than
  skipping silently — the behaviour the untagged womblex pin was taken for.
- **`embed` genuinely needs a real key** (`kanon-2-embedder` is an API call).
- **`enrich` genuinely needs a real key too** (`kanon-2-enricher`), and it is on
  by default as of 2026-08-06: `enrichment.enabled: true` in
  `infra/womblex/redline.yaml`, because the pilot-report items read the graph.
  This is the first real Isaacus spend beyond embeddings.

Chunks are what every store-backed read is over — `IChunkStore`'s row has no
embedding field, and similarity search is deferred — so the embeddings are inert
for now. The store-load path writes `embedding=None` without complaint.

**A UAT run now needs a real Isaacus key**, because the script drives `embed`
and `enrich`. To run without an account, set `ISAACUS_API_KEY=uat-local` and
`enrichment.enabled: false`, and expect the script to fail at `embed` — you get
extraction and chunks, which is enough for the deterministic reads and not
enough for the graph.

`linking.enabled` stays **false**, and is not the same thing as enrichment. The
graph comes from `enrich`; `link` writes `*.entity_links.parquet`, which nothing
in redline reads, and its preflight hard-fails without a `linking.reference`
register — a tender corpus has none to point at.
