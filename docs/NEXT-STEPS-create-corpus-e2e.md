# Handover — running the Create Corpus live E2E in podman

**Date:** end of session. **Author:** agent. **Status:** code committed; run-stack
half-built; the actual Playwright run has NOT been executed yet.

Everything here uses podman via `flatpak-spawn --host podman` (plain `podman`/
`docker`/`npm`/`pnpm` are NOT on the shell PATH on this host — only a bundled
`node` inside the VSCodium server). Set once per shell:

```sh
export PM="flatpak-spawn --host podman"
```

---

## 1. What was committed

Three fork commits + three parent commits, in fork-first order (two-commit rule):

- **Submodule** `services/wayfinder` HEAD → `05947392fcc6104c30fdcb0e97bfe71f30eecc97`
  (`eb55e25` end-to-end override → `0594739` money-editor build fix)
- **Parent** redline HEAD → `6d95fdc`
  (`09b8564` view + sidecar → `6d95fdc` follows the fork fix, bumps gitlink + pin
  to `0594739`, adds this note)

Both working trees are clean. Nothing pushed; no PR (none requested). The gitlink
is now the only Wayfinder pin — verify with
`git -C services/wayfinder rev-parse HEAD` before rebuilding.

NOTE: the first attempt to build the web image FAILED — the override edit had
replaced the money-vocabulary editor's inputs (leaving two helpers unused →
production `next build` no-unused-vars lint error). That is FIXED in `0594739`.
The committed code now typechecks clean; rebuild from this state (§4).

The changes: the extraction/OCR override (`ocrEngine` / `ocrDpi`) now reaches the
served surface end-to-end (tRPC zod input → redline-web view → the Create Corpus
tab), plus a router test; the create-corpus spec's live half stages a real
multi-document corpus; the guide is corrected; and a new run-capable sidecar
compose override was added (see below).

---

## 2. The one code-level discovery that blocks the live run

The shipped `ingest`-profile `womblex-ingest` sidecar is **womblex-free** and sets
no `WOMBLEX_DB_DSN` / `WOMBLEX_STORE_URI`, so its `POST /runs` route **503s**
("run trigger is not configured") and cannot import the engine the trigger drives.
**The create-corpus spec's live half has therefore never been runnable against the
stock stack.** New file `infra/docker-compose.run-sidecar.yml` fixes this: it serves
the `money` image (which has the engine + the sidecar package) as the FastAPI app
with the trigger env wired. This is local E2E scaffolding, not a shipped topology.

---

## 3. Exact podman resource names (this host has many pods — be precise)

**redline backend — project `redline` (compose `name: redline`):**

| Container | Image | Host port | Role |
|---|---|---|---|
| `redline-minio-1` | minio | 9000/9001 | object storage (bucket `redline`) |
| `redline-redline-postgres-1` | postgres:16 | 5433→5432 | redline_ schema (chunk store) |
| `redline-womblex-queue-1` | postgres:16 | (internal 5432) | engine job queue (`womblex_jobs` present) |
| `redline-womblex-init-1` | redline-womblex-init | — | one-shot schema init (Exited 0) |
| `redline-womblex-ingest-1` | redline-womblex-ingest | **8000** | shipped read-seam sidecar — **CANNOT fire runs (503)** |
| **`redline-womblex-run-sidecar-1`** | **redline-womblex-run-sidecar** | **8001** | **the run-capable sidecar I added — USE THIS for runs** |

The run-capable sidecar is UP and healthy (uvicorn started, trigger wired). Its
`WOMBLEX_MODE=real`, `REDLINE_DATABASE_URL` set, and it has a **real ISAACUS key**
(`iuak_v1_...`, read from `infra/.env` → `infra/uat/.env.uat`) — so the full
Isaacus path (chunk/embed/enrich) can run, i.e. `E2E_REDLINE_ISAACUS=1` and the
"hands the finished corpus over" test are viable.

**fork web app — project `redline-uat` (compose `name: redline-uat`):**

| Container | Image | Host port | Note |
|---|---|---|---|
| `redline-uat-wayfinder-web-1` | redline-uat-wayfinder-web | **3000** | **SERVING STALE CODE — must rebuild (see §4)** |
| `redline-uat-wayfinder-postgres-1` | pgvector:pg16 | 5443→5432 | fork's own pg |
| `redline-uat-wayfinder-minio-1` | minio | 9020/9021 | fork's own minio |
| `redline-uat-langfuse-1` | langfuse:2 | 3030 | optional |

The `redline-uat` web app currently points `REDLINE_WOMBLEX_INGEST_URL` at
`http://womblex-ingest:8000` (the 503 sidecar). It must be repointed at the
run-capable one (§5).

**Ignore these (unrelated, all Exited weeks ago):** `wayfinder-web`,
`wayfinder-api`, `wayfinder-minio`, `wayfinder-postgres`, `wayfinder-langfuse`,
`wayfinder-seed-pia`, `wayfinder-migrate`, `wayfinder-australian-writing-mcp`.
These are a DIFFERENT (non-redline) wayfinder deployment. Do not touch them.

---

## 4. STALE web image — rebuild required (the long pole, ~10-20 min)

`redline-uat-wayfinder-web-1` was built 8 days ago, before my code changes, so it
does NOT contain the OCR override UI. A rebuild from repo root picks up all three
changed layers (it globs the parent `@redline/*` packages + copies the fork).

The session's background rebuild FAILED on the now-fixed build bug (see §1); just
rebuild fresh from the committed state:

```sh
# (re)build cleanly — from repo root, needs --env-file for the ${VAR:?} guards:
cd "/run/media/toothy/DeepCivic_1/projects/Sandbox Workspace/redline"
$PM compose -f infra/uat/docker-compose.yml --env-file infra/uat/.env.uat build wayfinder-web
```

Verify the rebuilt image actually has the change before trusting a run:

```sh
$PM run --rm --entrypoint grep docker.io/library/redline-uat-wayfinder-web:latest \
  -rc "Override extraction and OCR" \
  /app/services/wayfinder/apps/web/src/app/'(user)'/create-corpus/_content.tsx
# want: a line ending ':1' (0 = still stale)
```

---

## 5. Bring up the rebuilt web app, pointed at the run-capable sidecar

The web app must reach `redline-womblex-run-sidecar` over the `redline_default`
network (the `redline-uat` project already joins it — see the `redline:` external
network in `infra/uat/docker-compose.yml`). Override the ingest URL when starting:

```sh
cd "/run/media/toothy/DeepCivic_1/projects/Sandbox Workspace/redline"
REDLINE_WOMBLEX_INGEST_URL=http://womblex-run-sidecar:8000 \
  $PM compose -f infra/uat/docker-compose.yml --env-file infra/uat/.env.uat \
  up -d wayfinder-web
```

If compose does not pass that through, edit the `REDLINE_WOMBLEX_INGEST_URL` line
in `infra/uat/docker-compose.yml` (currently `http://womblex-ingest:8000`) to
`http://womblex-run-sidecar:8000` and `up -d` again. NOTE the service alias is
`womblex-run-sidecar` (from `name: redline` + service name), reachable by that DNS
name on `redline_default`.

**Also required for Playwright auth:** the web container needs `TEST_AUTH_BYPASS=true`
(the `auth.setup.ts` hits `/api/auth/test-session`, which is gated on it). It is
NOT set in `infra/uat/docker-compose.yml` today — add it to the `wayfinder-web`
`environment:` block, e.g.:

```yaml
      TEST_AUTH_BYPASS: "true"
      TEST_ADMIN_EMAIL: ${ADMIN_SEED_EMAIL:-admin@example.com}
```

then `up -d wayfinder-web`. Without it, `auth.setup.ts` fails and every spec is
blocked.

Smoke-check the app is serving:  `curl -s localhost:3000/api/health` (or just load
`http://localhost:3000` in a browser and confirm login/admin works).

---

## 6. Run the Playwright spec (no npm/pnpm on host — run it in a node container)

The e2e package (`services/wayfinder/apps/web/e2e`) has NO `node_modules` and this
host has no package manager, so run Playwright inside a node container joined to
`redline_default`, targeting the web app by service name. Mount the repo with
`--userns=keep-id` (external-drive + rootless podman needs this; `:z` also works
for the mount label).

```sh
cd "/run/media/toothy/DeepCivic_1/projects/Sandbox Workspace/redline"
$PM run --rm -it \
  --userns=keep-id \
  --network redline_default \
  -v "$PWD/services/wayfinder/apps/web/e2e:/e2e:z" \
  -w /e2e \
  -e BASE_URL=http://wayfinder-web:3000 \
  -e TEST_ADMIN_EMAIL=admin@example.com \
  -e E2E_REDLINE_RUN_STACK=1 \
  -e E2E_REDLINE_ISAACUS=1 \
  -e E2E_REDLINE_CORPUS=/e2e/_corpus \
  mcr.microsoft.com/playwright:v1.50.0-jammy \
  sh -lc 'npm install && npx playwright install chromium && npx playwright test --config playwright.config.ts redline-create-corpus.spec.ts'
```

Decisions to make before running:

- **`E2E_REDLINE_ISAACUS=1`** → runs the "keyless refusal" test as SKIP and runs
  the two paid tests (chunk/embed/enrich = real Isaacus spend, the key is live).
  UNSET it to instead assert the keyless-refusal path (no spend) — but the
  run-capable sidecar HAS a real key, so the keyless test would then wrongly see
  chunk succeed. Match this flag to the sidecar's key state: key present ⇒ set it.
- **`E2E_REDLINE_CORPUS`** — the spec defaults to the repo's redistributable corpus
  at `services/womblex-ingest/tests/corpus` via a `../../../../../` relative path
  from the spec. Inside this container the repo is NOT mounted at that relative
  location (only `/e2e` is), so **either** mount the whole repo instead of just
  `/e2e` and drop `E2E_REDLINE_CORPUS`, **or** copy a corpus to
  `services/wayfinder/apps/web/e2e/_corpus/` first and point at `/e2e/_corpus`.
  Simplest: mount the repo root and let the default resolve:
  `-v "$PWD:/repo:z" -w /repo/services/wayfinder/apps/web/e2e` (then the spec's
  relative default finds `/repo/services/womblex-ingest/tests/corpus`).
- The base image tag `v1.50.0` should match the e2e `@playwright/test` version
  (`package.json` devDeps: `^1.50.0`). Bump the tag if that package.json moves.

The 4 client-side tests should pass immediately once §4/§5 are done. The 4 live
tests (`test.skip(!RUN_STACK)`) exercise `redline-womblex-run-sidecar` end to end
— give them room; each is up to 5 min (`RUN_TIMEOUT_MS`), real engine on a cold
container.

---

## 7. If a live run fails, first checks (in order)

```sh
# a) run-capable sidecar wired + healthy?
$PM logs --tail 40 redline-womblex-run-sidecar-1

# b) did POST /runs actually fire (not 503)? watch while a test runs:
$PM logs -f redline-womblex-run-sidecar-1

# c) is the engine queue taking jobs?
$PM exec redline-womblex-queue-1 psql -U womblex -d womblex \
  -c "select run_id, batch_num, status from womblex_jobs order by 1 desc limit 10;"

# d) did shards land in MinIO under the run's prefix?
$PM exec redline-minio-1 sh -lc \
  'mc alias set L http://localhost:9000 minioadmin minioadmin >/dev/null 2>&1; \
   mc ls --recursive L/redline/proc/ | tail -30'
```

Known sharp edges:
- The web app must point at `womblex-run-sidecar:8000`, NOT `womblex-ingest:8000`
  (§5) — else `POST /runs` 503s and the run never fires.
- `WOMBLEX_STORE_URI` for the run sidecar is the **bucket root** `s3://redline`
  (the trigger composes `proc/{eval}/inputs` + `proc/{eval}/runs/{runId}` itself).
  Do not root it at `proc/...` or prefixes double up. (Already correct in the
  override file.)
- The run stages the corpus the browser uploads into `proc/{runName}/inputs/`;
  the engine reads from there. If `enqueue` says "no staged documents", the
  browser→createCorpus→MinIO write did not land — check the web app's own MinIO
  write path and that `REDLINE_WOMBLEX_INGEST_URL` is the run sidecar.

---

## 8. Teardown of ONLY what this task added (leave everything else alone)

```sh
# the run-capable sidecar I added:
$PM rm -f redline-womblex-run-sidecar-1
$PM rmi docker.io/library/redline-womblex-run-sidecar:latest   # optional

# do NOT down the redline / redline-uat projects unless you mean to — other pods
# and 9+ days of state live there.
```

The compose override lives at `infra/docker-compose.run-sidecar.yml` (committed).
```
