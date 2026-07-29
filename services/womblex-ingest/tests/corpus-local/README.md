# Local (non-redistributable) test corpus

This directory holds **real / non-redistributable** documents used to exercise the
womblex pod locally. Its contents are **git-ignored** (see the root
`.gitignore`) — only this README is tracked. Do not commit documents here; if a
fixture is safe to redistribute it belongs in the sibling `corpus/` instead.

Current local set (not in git):

- `SynthResponse1.pdf`, `SynthResponse2.pdf`, `SynthResponse3.pdf` — synthetic
  tender responses.
- `PIN_2026_0334 - Technology PoC REOI Document.pdf` — the REOI tender document.

## Run the engine against this corpus

```sh
WOMBLEX_CORPUS=services/womblex-ingest/tests/corpus-local \
  scripts/womblex-engine-smoke.sh
```

`WOMBLEX_CORPUS` overrides the corpus the smoke test stages into object storage
(default: the redistributable `corpus/`). The engine extracts → chunks →
(embeds, when `ISAACUS_API_KEY` is set) every file here and publishes the Parquet
shards to MinIO under `proc/{evaluationId}/`.
