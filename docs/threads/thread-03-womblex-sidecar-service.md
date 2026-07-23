# Thread 3 — womblex sidecar service

**Status:** ✅ Complete · **Date:** 2026-07-24 · **Version intent:** MINOR (new service + ADR-0002; no breaking changes, pre-1.0)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 1](../procurement-evaluation-plan.md)
· ADRs: [ADR-0001](../adr/0001-adapter-over-wayfinder.adr.md), [ADR-0002](../adr/0002-own-minio-and-postgres.adr.md)

## Goal

Stand up `services/womblex-ingest`: a womblex document-extraction sidecar with an
HTTP wrapper — `ingest(documents) → run_id`, `status(run_id)` — that writes Parquet
shards to MinIO under `proc/{evaluationId}/`. Isaacus is behind an opt-in build arg.

**Exit test:** compose up, POST docs, shards land in MinIO. **→ PASSED** (evidence below).

## Cross-cutting decision locked

Build plan §8 **decision #4** (shared vs separate MinIO/Postgres) was *decide before
Thread 3*. Locked in **[ADR-0002](../adr/0002-own-minio-and-postgres.adr.md)**: redline
owns its own MinIO (bucket `redline`, shards under `proc/{evaluationId}/`) and its own
Postgres (`redline_` prefix). The seam stays plain S3/Postgres, so a deployment can still
collapse to a shared instance purely by config — honouring ADR-0001's "design as if C".

## What was built

A **foreign-runtime sidecar** (FastAPI, Python), composed over runtime seams
(HTTP + object storage), never imported into the TypeScript packages — mirroring
Wayfinder's `services/australian-writing-mcp` precedent.

### Files created

| File | Role |
|---|---|
| `services/womblex-ingest/pyproject.toml` | Package + deps (fastapi, uvicorn, boto3, pydantic); `womblex` + `dev` extras |
| `src/womblex_ingest/config.py` | Env-driven `Settings` (S3 target, `WOMBLEX_MODE`) |
| `src/womblex_ingest/storage.py` | `ObjectStorage` protocol + boto3-backed `S3ObjectStorage` (auto-creates bucket) |
| `src/womblex_ingest/extraction.py` | `Shard`/`ExtractionResult`, `Extractor` protocol, `StubWomblexExtractor`, `build_extractor` |
| `src/womblex_ingest/real_extractor.py` | Lazily-imported real womblex path (finalised in Thread 4) |
| `src/womblex_ingest/runs.py` | In-memory `RunRegistry` (running/succeeded/failed) |
| `src/womblex_ingest/main.py` | FastAPI app: `/health`, `POST /ingest`, `GET /status/{run_id}`; `build_app` (DI for tests) + `build_app_from_env` |
| `src/womblex_ingest/asgi.py` | ASGI entrypoint (`uvicorn womblex_ingest.asgi:app`) |
| `tests/conftest.py` | In-memory fakes for both seams + `TestClient` fixture |
| `tests/test_ingest_api.py` | HTTP surface + run lifecycle (11 tests) |
| `tests/test_stub_extractor.py` | Deterministic stub behaviour (3 tests) |
| `services/womblex-ingest/Dockerfile` | Python 3.12 image; `INSTALL_WOMBLEX` / `ISAACUS` opt-in build args; TCP `/health` healthcheck |
| `services/womblex-ingest/README.md` | Service docs (HTTP surface, modes, config, run/test) |
| `infra/docker-compose.yml` | `minio` + `womblex-ingest` under the `ingest` profile |
| `scripts/thread-03-smoke.sh` | The exit test as a repeatable script |
| `docs/adr/0002-own-minio-and-postgres.adr.md` | Locks decision #4 |

### Files modified

- `validate.sh` — added **check #10** (womblex-ingest pytest; SKIPs without python3),
  and extended the file-size guard (#9) to `services/*/src` `.py` files.
- `services/README.md` — womblex-ingest now points at the real service + infra/compose.
- `docs/adr/README.md` — ADR-0002 indexed.
- `docs/procurement-evaluation-plan.md` — §8 #4 locked; §10 row + thread log.

## Design decisions

1. **Synchronous runs, in-memory registry.** womblex over a small document set is
   fast enough for the review flow; `status` reports terminal states. MinIO is the
   durable record — the registry is process-local and non-durable by design. A
   queue/worker split is deferred until runs prove long.
2. **Stub extractor is the default (`WOMBLEX_MODE=stub`).** It emits the shard
   *layout* womblex produces (`_manifest` + per-document shards) without the heavy
   dependency or Isaacus, so the exit test and the air-gapped mode (Thread 15) run
   with zero external deps. The real womblex *schema* is pinned in Thread 4, where
   the Parquet/JSON boundary is decided — so `real_extractor.py` fails loudly until
   then rather than emitting stub data under a `real` label.
3. **Result-shaped HTTP errors** (`{"error": {"code","message"}}`) so the Thread 4
   adapter maps them straight into a `DomainError`. Codes: `INVALID_REQUEST` (422),
   `RUN_NOT_FOUND` (404), `EXTRACTION_FAILED` (502).
4. **Isaacus is doubly opt-in** — an image build arg (`ISAACUS=1`) *and* a runtime
   key (`ISAACUS_API_KEY`); womblex's non-Isaacus modes remain available.

## Exit-test evidence

Ran the compose stack via Podman 5.8 (`podman compose`, `ingest` profile) against a
real MinIO:

```
GET  /health                       → {"status":"ok","bucket":"redline"}
POST /ingest {evaluationId:smoke-1, → 202 {"runId":"1f65d804-…","status":"succeeded",
      documentNames:[tender.pdf,          "documentCount":2,
      pricing.xlsx]}                      "shardKeys":["proc/smoke-1/_manifest.parquet",
                                            "proc/smoke-1/tender.pdf.elements.parquet",
                                            "proc/smoke-1/pricing.xlsx.elements.parquet"]}

mc ls local/redline/proc/smoke-1/  → _manifest.parquet
                                      pricing.xlsx.elements.parquet
                                      tender.pdf.elements.parquet   ← shards landed in MinIO

GET  /status/1f65d804-…            → 200 {status:"succeeded", shardKeys:[…3…]}
GET  /status/nope                  → 404
```

Unit suite (isolated venv, Python 3.13): **12 passed**.
`./validate.sh` → **Passed: 10, Failed: 0** (incl. new check #10, womblex-ingest pytest).

## Known limitations / follow-ups

1. **Real womblex not yet wired.** `WOMBLEX_MODE=real` raises `NotImplementedError`;
   the concrete womblex call surface + real Parquet schema are finished in **Thread 4**
   (Parquet→JSON boundary), which also implements `IProcurementExtractionReader` over
   this service's output.
2. **Non-durable run registry.** Restarting the sidecar forgets in-flight run ids
   (output in MinIO survives). Revisit if a queue/worker split is warranted.
3. **Air-gap validation** (running with `ISAACUS_API_KEY` unset end-to-end) is
   formally exercised in **Thread 15**; the stub path already proves the no-Isaacus
   default here.

## How to reproduce

```bash
# unit tests
cd services/womblex-ingest && python3 -m venv .venv && . .venv/bin/activate \
  && pip install -e '.[dev]' && python -m pytest -q

# exit test (compose up → POST → assert shards in MinIO → teardown)
scripts/thread-03-smoke.sh              # or: COMPOSE="podman compose" scripts/thread-03-smoke.sh
```
