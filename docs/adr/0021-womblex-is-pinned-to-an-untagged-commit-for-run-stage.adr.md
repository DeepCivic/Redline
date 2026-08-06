# ADR-0021 — womblex is pinned to an untagged commit for `run-stage`

- **Date**: 2026-08-06
- **Amends**: [ADR-0015](./0015-upstream-python-engines-are-submodules.adr.md) (the pinning clause)

## Context

ADR-0015 settled that the upstream Python engines are submodules consumed for
what they already do, never reimplemented. It assumed, without saying so, that a
pin would be a **release tag**. womblex sat at `v0.3.0` (`b5730b0`) accordingly.

At `v0.3.0` the engine's distributed path stops at extraction. `womblex
run`/`worker` persists `elements` / `table_cells` / `form_fields` / `_manifest`
and nothing else: `write_batch_parquet` hands `write_results` only the extraction
(`operations/persist.py:18-27`), so the chunks that `batch.py:63-64` computes are
discarded. Every downstream stage (`chunk`, `embed`, `money`, …) was a `--shards`
command taking a **local directory**, while redline's shards live in object
storage.

redline had already papered over this once, for one stage: `money_stage.py` in
`services/womblex-ingest` implemented download-run-upload around
`money_shards()`. That was a redline reimplementation of an engine concern —
tolerated because the engine offered no alternative.

The consequence was worse than the duplication. **No path in redline produced
chunks at all**, and chunks are what the cold-start classifier reads. A corpus run
completed successfully, landed extraction shards, and left `redline_chunks`
empty. Nothing failed; the pipeline simply stopped early. Compounding it, the
`v0.3.0` chunk stage *skipped silently* when the Isaacus SDK was absent, so a
misbuilt image degraded invisibly too.

Upstream `f283969` (`main`, unreleased) adds **`womblex run-stage`**: the same
stage-in / run / stage-out shape, generalised from `finalize` to every per-batch
stage. It lists one sidecar class under a run's shard prefix, stages a unit down,
calls the unchanged `*_shards()` against that path, and publishes the declared
outputs back — all of them or none. It covers normalise, spellfix, chunk, money,
enrich, embed, link, pii, graph-refresh and quality. No `*_shards()` signature
changed and no filesystem abstraction was threaded through them.

It also converts the silent skip into a **refusal**: a stage whose Isaacus need
cannot be satisfied fails loudly rather than publishing nothing.

## Decision

**Pin `services/womblex` to `f283969` — an untagged `main` commit — rather than
wait for a release.**

Consequently:

- redline's `money_stage.py` and its tests are **deleted**. `run-stage --stage
  money` replaces them. Carrying both would be exactly the duplication ADR-0015
  forbids.
- The `money` compose profile becomes a general **`stage`** profile parameterised
  by `--stage`, built from the submodule's own Dockerfile with
  `EXTRAS=cloud,isaacus`.
- `scripts/womblex-engine-smoke.sh` drives `chunk` then `embed` after the worker
  drains. Its `.chunks` / `.embeddings` assertions previously tested for output
  the pipeline could not produce; they are now reachable, and are the exit test.

## Why an untagged pin is acceptable here

Taking an unreleased commit is a real risk, and it was weighed rather than waved
through:

- **The alternative is worse.** Waiting means either no chunks at all, or growing
  redline's own stage runner for `chunk` and `embed` beside the `money` one —
  more of the duplication we are trying to delete, and thrown away on release.
- **Its tests were unrun upstream, and we ran them.** The commit ships
  `tests/test_stage_runner.py` with a note that it had not been executed. All
  **33 tests pass** against the built image (fsspec local backend, no S3, no
  Postgres, no network).
- **The blast radius is narrow.** `run-stage` is additive: new CLI verb, new
  `cloud/stage_contracts.py` and `cloud/stage_runner.py`. No existing `*_shards()`
  signature moved, so the extraction path redline already depends on is untouched.
- **We own the upstream.** womblex is `DeepCivic/womblex`; a defect found here is
  funnelled upstream rather than worked around locally.

The pin returns to a tag at womblex's next release. Until then, `f283969` is
recorded here and in `architecture.md` so the deviation from ADR-0015's tag
assumption is visible rather than implicit.

## Consequences

- The documented pipeline shape changes: extraction is the worker's job, and
  everything downstream is an explicit `run-stage` pass whose **ordering is the
  caller's** (chunk before embed).
- `ISAACUS_API_KEY` becomes load-bearing earlier. It always gated chunk by policy,
  but that gate now fails a run instead of quietly trimming it — which is the
  behaviour this pin was taken for.
- A `run-stage` defect blocks redline's vertical rather than one stage. The 33
  passing tests and the smoke script's three assertions are the standing check.
