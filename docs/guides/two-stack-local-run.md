# Running both stacks locally

redline's UI is served by the **forked Wayfinder** (`services/wayfinder`,
ADR-0019), not by a standalone shell. So a working local environment is two
stacks side by side: redline's own services, and the fork's web app pointed at
them. This is the runbook for that.

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
Apply redline's migrations against the database once it is accepting
connections — `applyMigrations` is driver-agnostic and the production path runs
it through the `postgres` client:

```bash
DATABASE_URL=postgresql://redline:redline-dev@localhost:5433/redline \
  pnpm --filter @redline/redline-adapters db:migrate
```

The migration is idempotent, so re-running it is a no-op.

Confirm the sidecar answers before moving on: it is the extraction seam the
identifier-token pre-pass and the review grid both read through.

## 2. The fork's infrastructure

The fork keeps its **own** Postgres, MinIO and Langfuse — redline never shares
Wayfinder's database (ADR-0002):

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
| `REDLINE_ADJUDICATOR_BASE_URL` | any OpenAI-compatible chat/completions endpoint |
| `REDLINE_ADJUDICATOR_API_KEY` | that endpoint's key |
| `REDLINE_ADJUDICATOR_MODEL` | the model id to adjudicate with |
| `REDLINE_PRODUCT_NAME` | the product name the summary prompt names |

**Leaving `REDLINE_DATABASE_URL` blank is a supported state.** The fork then
boots as plain Wayfinder with the `/evaluations` routes unavailable, rather than
failing its fail-fast env parse. `resolveRedlineModule` returns `null` and
nothing else in the container notices.

The adjudicator is **not** optional in the same way: cold-start classification is
hard rules plus LLM adjudication, so `REDLINE_ADJUDICATOR_*` must point at a
reachable OpenAI-compatible endpoint or nothing classifies.

`pnpm install` here runs `onnxruntime-node`'s postinstall, which downloads a
native binary. On a restricted network it fails the whole install; the fork's own
infrastructure does not need it, so `pnpm install --config.ignore-scripts=true`
gets you a working web app when that download is blocked.

---

## 4. A corpus, and the evaluation over it

Run the engine over the corpus first. The shards it lands are what everything
downstream reads:

```bash
WOMBLEX_CORPUS=services/womblex-ingest/tests/corpus-local \
  scripts/womblex-engine-smoke.sh
```

Then seed an evaluation from a manifest:

```bash
cd services/wayfinder
pnpm --filter @wayfinder/web seed:redline path/to/manifest.json
```

It prints the evaluation id, the `/evaluations/:id/review` URL, and the
`E2E_REDLINE_EVALUATION_ID=` line the Playwright specs gate on.

### The manifest, and the one thing that will catch you

**`documentIds` are womblex `source_hash` values, not filenames.** `source_hash`
is womblex's document identity (`shard_reader.py`) — a sha256 that does not
exist until the engine has extracted the document. So the manifest can only be
written *after* step 4's engine run, and the ids come from the run's
`manifest.parquet` (the published `source_hash` → `doc_id`/filename table), not
from anything you can read off the corpus directory.

```json
{
  "evaluationId": "cloud-rft-2026",
  "evaluationName": "Cloud Hosting RFT 2026",
  "lens": {
    "lensId": "cloud-rft-2026-lens",
    "name": "Cloud hosting evaluation",
    "topics": [
      { "id": "hosting", "name": "Hosting", "definition": "Compute, storage and network provisioning." },
      { "id": "support", "name": "Support", "definition": "Service levels, response times and escalation." }
    ],
    "rules": [
      { "id": "rule-sla", "pattern": "service level", "topicId": "support" }
    ]
  },
  "vendors": [
    { "id": "acme", "displayName": "Acme Cloud" },
    { "id": "globex", "displayName": "Globex Hosting" }
  ],
  "groups": [
    { "id": "acme-response", "label": "Acme", "vendorIds": ["acme"], "documentIds": ["<source_hash>"] },
    { "id": "globex-response", "label": "Globex", "vendorIds": ["globex"], "documentIds": ["<source_hash>"] }
  ]
}
```

A document belongs to exactly one group — `assignDocument` moves rather than
copies, so claiming one document for two groups is rejected. Rules are matched
by specificity then declaration order (ADR-0011), so their order in the file is
load-bearing.

## What you can and cannot reach

Once both stacks are up, the `/evaluations` index is linked from the sidebar and
`/evaluations/:id/{review,pivots,grouping}` and
`/evaluations/:id/documents/:documentId` are served — all gated on the
`evaluation:review` permission, which is seeded to a specialist role, so an
ordinary non-admin test account can reach them.

Not yet in place, and tracked in `delivery-plan.md`: **nothing served creates or
edits an evaluation.** The seeding script above is the only write path, and the
lens still comes from the hand-written manifest. The grouping page is read-only.

## Isaacus

The two stages are gated differently, and the difference decides whether you
need an account.

- **`chunk` is gated by policy, not capability.** `chunk_shards` returns early
  when `isaacus_available()` is false — a network-free check for the `isaacus`
  package plus a **non-empty** `ISAACUS_API_KEY`. With no `chunking_model` set
  (redline's profile sets none), `create_chunker` resolves the Kanon-2 tokeniser
  from womblex's vendored copy at `_models/kanon-2-tokenizer/` and makes no API
  call. So any non-empty string satisfies it: `ISAACUS_API_KEY=uat-local` is
  enough to produce chunks offline.
- **`embed` genuinely needs a real key** (`kanon-2-embedder` is an API call).

Chunks are what the cold-start classifier reads — `IChunkStore`'s row has no
embedding field, and ADR-0018's addendum defers similarity search — so the
embeddings are inert for this path. The store-load path writes `embedding=None`
without complaint.

**A UAT run therefore needs no Isaacus account.** A pilot that wants
nearest-neighbour placement does.
