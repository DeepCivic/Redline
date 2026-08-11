# UAT — both stacks in Podman

Runs the forked Wayfinder web app **and** redline's backing services in podman,
so you can click through Wayfinder and (with an adjudicator key) a seeded redline
evaluation.

This is local UAT scaffolding. The shipped design runs the fork's `apps/web` on
the host with `pnpm dev` — see
[`docs/guides/two-stack-local-run.md`](../../docs/guides/two-stack-local-run.md).
It exists because this host has no local Node.

## Topology

Two compose projects on one network. redline's project (`redline`) owns MinIO,
Postgres and the sidecar; this one (`redline-uat`) adds the fork and attaches to
redline's network to reach them by service name.

**There is one MinIO, deliberately.** The womblex engine publishes shards into
redline's bucket and the sidecar reads them back from it. A second MinIO for the
fork would leave every seeded evaluation reading an empty prefix while looking
perfectly healthy.

| Service | Project | Purpose | Host port |
|---|---|---|---|
| `wayfinder-web` | `redline-uat` | the forked Wayfinder app (what you click) | http://localhost:3000 |
| `langfuse` | `redline-uat` | observability (optional) | 3030 |
| `wayfinder-postgres` | `redline-uat` | the fork's own Postgres (pgvector) | 5443 |
| `wayfinder-minio` | `redline-uat` | the fork's object storage + console | 9020 / 9021 |
| `redline-postgres` | `redline` | the `redline_` schema (ADR-0002) | 5433 |
| `minio` | `redline` | redline's object storage + console | 9000 / 9001 |
| `womblex-ingest` | `redline` | Parquet→JSON extraction sidecar | 8000 |

The fork's own `docker-compose.yml` publishes 5433 and 9000/9001 — exactly
redline's ports. This overlay shifts the fork to 5443 and 9020/9021 so both
stacks can run. Container-internal ports are unchanged.

All commands are run from the repo root. `$PODMAN` is your podman invocation; on
a flatpak host that is `PODMAN="flatpak-spawn --host podman"`.

## 1. redline's services

`infra/.env` holds the settings, and two of them decide whether the run is real:

```bash
$PODMAN compose -f infra/docker-compose.yml --profile ingest up -d
curl -s localhost:8000/health   # {"womblexMode":"real", ...}
```

`WOMBLEX_MODE` **must** read `real`. The compose default is `stub`, a
dependency-free test double that serves fabricated shards — a UAT run left on it
looks like it succeeded while showing invented documents.

> **First run only:** `redline-postgres` may fail the `up` with *"dependency
> failed to start … unhealthy"*. `initdb` on slower storage overruns the
> healthcheck's 60s budget. The database finishes initialising regardless —
> re-run the same command and it comes up healthy.

## 2. The fork, and the web app

`.env.uat` is gitignored (it holds live keys). Create it from the template — the
three secrets at the top are mandatory, the compose refuses to start without them:

```bash
cp infra/uat/.env.uat.example infra/uat/.env.uat
openssl rand -hex 32   # once per secret
```

```bash
$PODMAN compose -f infra/uat/docker-compose.yml --env-file infra/uat/.env.uat up -d --build
```

The first build compiles the combined pnpm workspace (the fork plus redline's
`@redline/*` packages) — allow 10–20 min. Watch it with
`... logs -f wayfinder-web`.

## 3. redline's schema

The web container's own start-up migrates *Wayfinder's* database, not redline's.
Apply redline's migrations separately — it holds the workspace, so run it there:

```bash
$PODMAN compose -f infra/uat/docker-compose.yml exec wayfinder-web \
  sh -lc 'cd /app && DATABASE_URL="$REDLINE_DATABASE_URL" pnpm --filter @redline/redline-adapters db:migrate'
```

The migration is idempotent, so re-running it is a no-op.

## 4. First-run setup (no key needed)

Open http://localhost:3000. On first boot the app prints a clickable
`/setup?token=…` link to the web container's log:

```bash
$PODMAN compose -f infra/uat/docker-compose.yml logs wayfinder-web | grep -i setup
```

Create the admin account; the wizard then walks object storage and an AI
provider. All of Wayfinder is clickable from here, and `/evaluations` is linked
from the sidebar and renders its empty state.

## 5. A clickable evaluation (needs an adjudicator key)

`REDLINE_ADJUDICATOR_API_KEY` is blank in `.env.uat` on purpose. Nothing can be
seeded without it: cold-start classification is hard rules plus LLM adjudication,
so the seed script classifies as it runs. Set it, then
`... up -d wayfinder-web` to pick it up.

Nothing served creates an evaluation (delivery-plan §2) — seeding is the only
write path, and it needs shards to read.

```bash
# a) run the engine over the corpus. Both variables are load-bearing:
#    KEEP_UP=1 or the script's `compose down -v` destroys its own output, and
#    WOMBLEX_EVAL_ID must equal the manifest's evaluationId — the sidecar reads
#    proc/{evaluationId}/ and returns whatever is under that prefix.
KEEP_UP=1 \
WOMBLEX_EVAL_ID=cloud-rft-2026 \
WOMBLEX_CORPUS=services/womblex-ingest/tests/corpus-local \
  scripts/womblex-engine-smoke.sh

# b) write the manifest. `documentIds` are womblex `source_hash` values, NOT
#    filenames — they do not exist until (a) has run, and come from the run's
#    manifest.parquet. See two-stack-local-run.md for the worked example.

# c) seed. Pass an ABSOLUTE path: pnpm --filter runs the script with the package
#    directory as its working directory.
$PODMAN compose -f infra/uat/docker-compose.yml exec wayfinder-web \
  sh -lc 'cd /app/services/wayfinder && pnpm --filter @wayfinder/web seed:redline /app/manifest.json'
```

It prints the evaluation id, the `/evaluations/:id/review` URL and the
`E2E_REDLINE_EVALUATION_ID=` line the Playwright specs gate on. The
`evaluation:review` permission is seeded to a specialist role, so an ordinary
non-admin test account can reach it.

A UAT run needs **no Isaacus account** — `ISAACUS_API_KEY=uat-local` in
`infra/.env` produces chunks offline. Only the embed stage spends against a real
key, and its output is inert while ADR-0018's addendum defers similarity search.

## 6. The report tool server (optional)

The report assembler reaches redline's rows through `apps/redline-mcp`, an MCP
server over streamable HTTP. Bring it up under the `report` profile — it shares
redline's Postgres and sidecar, so it joins the `redline` project, not this one:

```bash
$PODMAN compose -f infra/docker-compose.yml --profile report up -d redline-mcp
curl -s localhost:8930/health   # {"status":"ok", ...}
```

Register it in Wayfinder from the same web container. The seed is a
list-then-create guard over `RegisterMcpServer`, so re-running it is a no-op —
it registers `streamable-http` at `http://redline-mcp:8930/mcp` with
`communicatesExternally: false` (invariant 7 — `true` would make it unselectable
in flows and the assembler unbuildable):

```bash
$PODMAN compose -f infra/uat/docker-compose.yml exec wayfinder-web \
  sh -lc 'cd /app/services/wayfinder && pnpm --filter @wayfinder/web seed:redline-mcp'
```

It prints whether the server was newly registered or already present, and the
registered id. The report assembler is now selectable in a flow.

## Tear down

```bash
$PODMAN compose -f infra/uat/docker-compose.yml down          # the fork
$PODMAN compose -f infra/docker-compose.yml --profile ingest --profile report down
```

Add `-v` to either to drop its volumes. Tearing down `redline-uat` leaves
redline's network alone — this project attaches to it rather than owning it.
