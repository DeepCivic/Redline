# Local (non-redistributable) test corpus

This directory holds **real / non-redistributable** documents used to exercise the
womblex pod (Thread 37a) locally. Its contents are **git-ignored** (see the root
`.gitignore`) — only this README is tracked. Do not commit documents here; if a
fixture is safe to redistribute it belongs in the sibling `corpus/` instead.

Current local set (not in git):

- `SynthResponse1.pdf`, `SynthResponse2.pdf`, `SynthResponse3.pdf` — synthetic
  tender responses.
- `PIN_2026_0334 - Technology PoC REOI Document.pdf` — the REOI tender document.

## Run the pod against this corpus

```sh
WOMBLEX_CORPUS=services/womblex-ingest/tests/corpus-local \
  scripts/thread-37a-womblex-pod.sh
```

`WOMBLEX_CORPUS` overrides the compose `womblex` service's default input mount
(which points at the redistributable `corpus/`). The pod extracts → chunks →
(embeds, when `ISAACUS_API_KEY` is set) every file here and lands the Parquet
shards in MinIO under `proc/{evaluationId}/`.
