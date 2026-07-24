# Thread 15 — Isaacus-optional & air-gap validation

**Status:** ✅ Complete · **Date:** 2026-08-05 · **Version intent:** MINOR (pre-1.0; new health surface + UI config view + air-gap proof)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 5](../procurement-evaluation-plan.md)
· ADRs: [ADR-0002](../adr/0002-own-minio-and-postgres.adr.md) (own MinIO — the
seam stays plain S3 so the pipeline runs disconnected), building on the Thread 3
sidecar ([thread-03](./thread-03-womblex-sidecar-service.md)).

## Goal

Prove womblex's **non-Isaacus path end-to-end**; document both modes; surface as
a UI config toggle.

**Exit test:** the full pipeline runs with `ISAACUS_API_KEY` unset. **→ PASSED.**

## What was built

The stub extractor already ran without Isaacus (Thread 3), but nothing *modelled*
Isaacus-optionality explicitly, *proved* the whole ingest→read pipeline degrades
cleanly with the key unset, or *surfaced* the live path to the UI. Thread 15 closes
all three.

### Service — `services/womblex-ingest` (explicit enrichment mode)

| File | Change |
|---|---|
| `src/womblex_ingest/config.py` | `Settings` now reads `ISAACUS_API_KEY` and exposes an `EnrichmentMode` (`offline` \| `isaacus`) derived from `WOMBLEX_MODE` + a non-blank key: **stub is always offline** (the stub never calls Isaacus, even if a key is present); **real is offline unless a non-blank key is supplied**. `isaacus_enabled` is the boolean the health surface reports. |
| `src/womblex_ingest/main.py` | `build_app` takes `womblex_mode` + `enrichment_mode`; `GET /health` now reports `{ status, bucket, womblexMode, enrichmentMode, isaacusEnabled }` so a deployment/UI can read which path is live. `build_app_from_env` wires the derived mode. |
| `tests/test_enrichment_mode.py` | 6 tests pinning the derivation rule (stub-with-key → offline, real-no-key → offline, real-with-key → isaacus, a blank key is unset, `from_env` defaults). |
| `tests/test_airgap_pipeline.py` | **The exit test (offline).** Builds the app the way the process does at startup with `ISAACUS_API_KEY` deleted (S3 faked in place), asserts `/health` reports `offline`, then drives the whole seam — `POST /ingest` → shards land → `GET /extractions/...` serves the JSON read model — with no Isaacus, no network. |
| `tests/test_ingest_api.py` | +3 tests: `/health` reports `offline` by default and `isaacus` when enabled. |
| `README.md` | Documents **both modes** (a `WOMBLEX_MODE` × `ISAACUS_API_KEY` → `enrichmentMode` table), the air-gap section, and the new `/health` fields. |

### Air-gap proof — `scripts/thread-15-airgap.sh`

The live (real MinIO + HTTP) counterpart to the offline pytest, mirroring
`thread-03-smoke.sh`: brings up the `ingest` profile **with `ISAACUS_API_KEY`
unset**, asserts `/health` reports `enrichmentMode: offline` / `isaacusEnabled:
false`, `POST /ingest` succeeds, shards land in MinIO, and the Parquet→JSON read
seam serves the document. Self-contained (safe local S3 defaults). **This ran live
under Podman 5.8 in this environment — see the evidence below.**

### Compose fix — profiles are now self-contained

Running the live proof surfaced a real defect: `infra/docker-compose.yml` guarded
the numbatch/redline DB passwords with `${VAR:?...}`, and compose interpolates the
**whole file regardless of `--profile`**, so `--profile ingest` refused to start
unless unrelated profiles' secrets were also set. Fixed by giving all credentials
overridable **dev defaults** (`minioadmin`, `*-dev` passwords) so any single profile
comes up standalone; production overrides them via `infra/.env`. The header comment
spells out that the dev defaults must never ship.

### UI config toggle — `apps/redline-web`

| File | Role |
|---|---|
| `src/lib/ingest-config.ts` | `parseIngestHealth(payload)` narrows the sidecar's `/health` JSON (null on an older/malformed response). `renderIngestConfigView(health)` → a presentation shape: extraction-mode label, enrichment label, `airGapped` flag, and an `isaacusToggle` (`on`/`disabled`/`hint`). The toggle is **disabled on the stub path** (always offline) and actionable only on the real extractor — the view encodes the doubly-opt-in constraint so the shell can't offer a toggle that can't take effect. Framework-free, pure, unit-tested (Threads 11–14 posture). |
| `src/index.ts` | Public surface (`renderIngestConfigView`, `parseIngestHealth` + types). |
| `src/lib/ingest-config.test.ts` | 5 tests: parse happy/reject paths; offline vs Isaacus views; the stub-disables-toggle rule. |
| `e2e/ingest-config.e2e.ts` | Playwright acceptance spec (offline by default; Isaacus engaged with a key) — authored now; executable gate is vitest until the Next.js shell serves `/evaluations/:id/settings/ingest`. |

## Design decisions

- **Enrichment mode is *derived*, not a fourth env var.** A single source of truth
  (`WOMBLEX_MODE` + key presence) avoids a config that can disagree with itself
  (e.g. `enrichment=isaacus` while the stub extractor is live). The stub is
  unconditionally offline because it never calls Isaacus.
- **Isaacus is doubly opt-in** (carried from Thread 3): the `ISAACUS=1` image *and*
  a runtime key. An air-gapped deployment sets neither. `real` with the key unset
  stays offline (womblex's own edge/offline mode).
- **The exit criterion is proven twice.** Offline (`test_airgap_pipeline.py`, gates
  in CI with no container) and live (`thread-15-airgap.sh`, real MinIO) — the same
  posture as Thread 3's stub-vs-smoke split.
- **`/health` is the single surface** both the deployment and the UI read; the UI
  view-model is a pure transform of it, so the toggle stays testable without a
  browser and without the sidecar.
- **The toggle encodes the constraint.** Disabled on the stub path so the shell
  never presents an Isaacus switch that can't take effect — the constraint lives
  in the tested view-model, not in DOM glue.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman; Python 3.13 on host):

```
10. services/womblex-ingest pytest → 27 passed (was 17; +10)
     tests/test_enrichment_mode.py   (6)
     tests/test_airgap_pipeline.py   (2)   ← the offline exit test
     tests/test_ingest_api.py        (+3 → 15)
     tests/test_stub_extractor.py    (5)
@redline/redline-web:test → 63 passed (was 58; +5 ingest-config)
turbo typecheck / lint / test / build → all green across the @redline/* packages
./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The exit criterion — *full pipeline runs with `ISAACUS_API_KEY` unset* — is proven
both offline (pytest) and **live under Podman**.

**Live run** (`scripts/thread-15-airgap.sh`, Podman 5.8, real MinIO, `ISAACUS_API_KEY`
unset, `ingest` profile brought up standalone):

```
>> waiting for /health
   -> {"status":"ok","bucket":"redline","womblexMode":"stub","enrichmentMode":"offline","isaacusEnabled":false}
>> POST /ingest (evaluationId=airgap-…)
   -> {"runId":"538ccb28-…","status":"succeeded","documentCount":1,
       "shardKeys":["proc/airgap-…/_manifest.parquet","proc/airgap-…/tender.pdf.elements.parquet"]}
>> MinIO listing (proc/airgap-…/):
     _manifest.parquet · c8dfc1c3abaa911d.extraction.json · tender.pdf.elements.parquet
>> GET /extractions/airgap-…/c8dfc1c3abaa911d
   -> {"documentId":"c8dfc1c3abaa911d","elements":[…]}
THREAD 15 EXIT TEST: PASSED — full pipeline ran with ISAACUS_API_KEY unset (offline enrichment).
```

**Offline run** (gates in CI without a container):
`test_airgap_pipeline.py::test_full_pipeline_runs_air_gapped` builds the app the way
the process does at startup with the key deleted and `/health` reporting
`enrichmentMode: offline`, then `POST /ingest` → `202 succeeded`, shards land under
`proc/airgap-1/`, and `GET /extractions/airgap-1/{sourceHash}` serves the JSON read
model (elements + `chunkId "{sourceHash}:0"`).

## Known limitations / follow-ups

1. **Real womblex still not wired.** The offline path is fully proven (live under
   Podman + offline in pytest); `real` mode raises `NotImplementedError` until the
   concrete womblex call surface lands (carried from Threads 3–4). The
   Isaacus-disabled *real* path (womblex's edge/offline mode) is therefore proven
   only at the wiring/health layer, not by running real womblex.
2. **No Next.js shell yet** — the config view is complete and tested; the settings
   route + the Playwright run are the Track 4 shell follow-up (shared with Threads
   11–14). `e2e/ingest-config.e2e.ts` pins the `/evaluations/:id/settings/ingest`
   DOM contract.
