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

From the repository root:

```bash
docker compose -f infra/docker-compose.yml --profile ingest up -d
```

That brings up `redline-postgres`, `minio` and the `womblex-ingest` sidecar.
Apply redline's migrations against the database once it is accepting
connections — `applyMigrations` is driver-agnostic and the production path runs
it through the `postgres` client.

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

---

## What you can and cannot reach yet

Once both stacks are up, `/evaluations/:id/{review,pivots,grouping}` are served
and gated on the `evaluation:review` permission, which is seeded to a specialist
role — so an ordinary non-admin test account can reach them.

Two things are **not** in place, and both are tracked in `delivery-plan.md`:

- **Nothing authors a lens, and nothing creates an evaluation.** The tables and
  the write-side use-cases exist, but no served procedure or script drives them,
  so there is no id to put in the URL yet. That is the delivery plan's next item.
- **There is no navigation entry to `/evaluations`.** Even with a valid id, the
  only way in is typing the URL. Worth fixing before anyone unfamiliar is asked
  to test.

## Isaacus

`ISAACUS_API_KEY` gates womblex's `chunk` **and** `embed` stages, so without it
extraction shards land but no chunks and no embeddings do — and there is then
nothing in the store to classify over. It is a hard dependency, not a degraded
mode (`architecture.md` §2).
