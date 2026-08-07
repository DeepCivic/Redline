# ADR-0008 — The trained classifier is an optional overlay; the first pass needs no samples

- **Self-amended 2026-07-27**: Isaacus is a hard requirement; air-gap is a non-goal — see the amendment at the end of this file.
- **Amended by**: [ADR-0018](./0018-retrieval-is-a-store-side-query-surface.adr.md) on the retrieval leg's mechanism only — the cold-start path *"hard rules → retrieval → adjudication"* is preserved.
- **Date**: 2026-07-24

## Context

The lens workflow ([ADR-0007](./0007-procurement-purpose-lens-means.adr.md))
promises that a specialist writes a handful of criterion definitions and the
corpus sorts itself — before curating examples. Reading the upstream engines as
built shows two hard facts that make the naive version of that impossible:

1. **Numbatch hard-enforces a training floor.** `MIN_SAMPLES_PER_TOPIC = 10`
   (`backend/app/models/profile.py:23`), validated at train time
   (`backend/app/services/training_jobs.py:85` — *"Every topic needs at least 10
   unique samples"*). A definition-only profile **cannot be trained**, so it can
   never reach the classifier.
2. **Numbatch has no retrieval.** No embeddings, no vector store, no
   nearest-neighbour — verified by search across `backend/`, `inference/` and
   `docs/`. Its path is chunks → LoRA adapter → roll-up.

Meanwhile **womblex already provides the missing leg**: `analyse/embed_stage.py`
consumes `*.chunks.parquet` and writes `*.embeddings.parquet`, joinable on
`(source_hash, chunk_index, content_type)` (`store/output.py:168`), described as
*"Chunks are the right granularity for retrieval."* redline runs a womblex
sidecar over those shards today and does not read them.

womblex also supplies the structural idiom. Its composable design treats a
missing upstream artefact as an *ordering* concern, not a dependency: `chunk`
reuses `enrich`'s sidecar when present and self-enriches when absent — *"run out
of order or without the sidecar and `chunk` self-enriches (composable
fallback)"*.

## Decision

**The trained Numbatch adapter is an optional overlay, not a required stage.**

- **First pass — no adapter, no samples.** Hard rules resolve deterministically
  first (documents they claim never reach a model); womblex embeddings provide
  nearest-neighbour matching against criterion definitions; an LLM adjudicates
  only what retrieval leaves unclear, emitting a one-sentence rationale.
- **Overlay engages later.** As boundary decisions accumulate into Numbatch topic
  samples and a topic clears `MIN_SAMPLES_PER_TOPIC`, the adapter is trained and
  activated, and subsequent runs use it.
- **Both paths satisfy the same port.** `RequirementClassification`
  (`{ documentId, requirementId, confidence, sourceChunkId, sourceElementOrder,
  unclassified }`) is produced by either path; consumers cannot tell which ran.
  The shape has since grown additively — `sourceElementOrder` and `unclassified`
  (and a nullable `requirementId`) let the cold-start path emit one row per topic
  a document addresses and surface a document that matched nothing rather than
  drop it — without disturbing this decision: both paths still emit the one shape.
- **No upstream constraint is weakened.** The training floor is not relaxed, and
  Numbatch is used exactly as built. This preserves
  [ADR-0005](./0005-numbatch-fork-all-but-frontend.adr.md)'s additive-only fork
  posture.

### Relationship to ADR-0004 (this does not reverse it)

[ADR-0004](./0004-user-defined-requirements-not-fixed-1-6.adr.md) considered and
**rejected** *"zero-shot classification from a prose definition (no sample
curation)"*, on the grounds that *"Numbatch does not classify zero-shot from a
description… Pursuing zero-shot would mean not using Numbatch as-is."*

That rejection stands and is not disturbed. This ADR does **not** ask Numbatch to
classify zero-shot. Numbatch continues to work exactly one way — curated samples
→ LoRA adapter → roll-up — and is reached only once its own precondition is met.
The first pass runs on **different machinery entirely** (womblex embeddings plus
an LLM adjudication port) and hands over to Numbatch when the floor is cleared.
ADR-0004 ruled on *how Numbatch may be used*; this ADR rules on *what happens
before Numbatch is usable at all*.

## Consequences

**Positive**

- The workflow is usable on day one, which is the whole basis of
  [ADR-0007](./0007-procurement-purpose-lens-means.adr.md).
- Both upstream engines are leveraged at full strength rather than weakened to
  fit: womblex's embeddings (built, previously unread by redline) and Numbatch's
  trained classification (built, previously unreachable at cold start).
- The first pass is fast. Training a LoRA adapter is minutes-to-hours on GPU;
  "map the corpus" cannot wait on it, and now does not.
- It degrades honestly. With no samples the lens is a retrieval-and-LLM sorter;
  with accumulated judgement it becomes a trained classifier. Same interface.

**Negative**

- **Two classification paths exist and must stay interchangeable.** That is
  ongoing surface to maintain and an obvious place for behavioural drift.
- **First-pass quality is unmeasured.** No corpus has been run; retrieval and
  adjudication thresholds are unset (design doc open question #5).
- A new LLM seam is required — `ILanguageModel.summarise` is procurement-shaped
  (`{ vendorName, productName, passages }`) and cannot carry adjudication
  (open question #2).
- Cost profile changes: LLM adjudication is a per-run expense the trained path
  does not have, giving a reason to cross the sample floor promptly.

## Alternatives considered

- **Relax `MIN_SAMPLES_PER_TOPIC` in the fork.** Rejected: a **non-additive**
  change to Numbatch, contradicting ADR-0005, and it would train a weak adapter
  on thin data — degrading the engine to fit our workflow rather than using it
  properly.
- **Require ~10 curated examples per criterion before any mapping runs.**
  Rejected: it defeats the earliest-usable-solution goal that justifies the lens
  architecture in the first place (ADR-0007). It is, however, the honest
  fallback if the first pass proves too weak in practice.
- **Build our own vector store for retrieval.** Rejected: womblex already
  produces the embeddings; see
  [ADR-0009](./0009-numbatch-library-is-system-of-record.adr.md) for the same
  principle applied to the topic library.

## Enforcement

- Thread 22's exit test is the gate: a fixture corpus classifies **with no
  trained adapter and no curated samples**.
- Thread 21's exit test asserts the model port is *unused* for rule-claimed
  documents (the fake asserts zero calls).
- Thread 34 engages the overlay on crossing the floor; its exit test requires the
  first-pass path to remain available and interchangeable at the port.
- ADR-0005's additive-only posture stays unamended — if a future change does
  require relaxing the floor, that needs its own ADR superseding this one.

---

## Amendment — Isaacus is a hard requirement; air-gap is a non-goal

- **Date**: 2026-07-27

### Context

This ADR made the *trained classifier* optional. Earlier work then carried a
second, separate optionality — an "Isaacus-optional / air-gapped" posture
inherited from womblex's own edge modes and Wayfinder's air-gap validation —
and the two were treated as one idea. They are not.

Reading womblex's source settles the question. Its stage split is:

- `detect` / `extract` — local (PyMuPDF, OCR, layout). No Isaacus.
- `chunk` (default) — local. The Kanon-2 tokeniser is free on Hugging Face, so
  plain token chunking needs no key. Only *AI* chunking calls the API.
- **`embed` — Isaacus-only** (`kanon-2-embedder`). This produces
  `*.embeddings.parquet`.

The cold-start path this ADR defines *is* nearest-neighbour matching over those
embeddings. So a deployment without `ISAACUS_API_KEY` gets extraction and chunks
and then stops: no vectors, no retrieval, no first pass, and — since the overlay
requires samples that only the first pass makes cheap to produce — no route to
classification at all.

An "air-gapped redline" was therefore never a degraded mode. It was a mode in
which the product does not function.

### Decision

**Retrieval requires `ISAACUS_API_KEY`. A deployment that cannot reach Isaacus is
misconfigured, not running in a supported mode.**

- The optionality this ADR grants applies to the **trained Numbatch adapter**
  only. It never applied to Isaacus, and the two must not be conflated again.
- `/health` reports `isaacusEnabled` as a **diagnostic**, so a misconfigured
  deployment is legible. It is not a mode selector.
- The stub extractor remains, scoped to what it was always for: a
  dependency-free test double for CI and the adapter contract. It is not an
  offline product lane.

### Consequences

- Removed: `EnrichmentMode.OFFLINE` and the `enrichmentMode` field,
  `scripts/thread-15-airgap.sh`, `tests/test_airgap_pipeline.py`,
  `tests/test_enrichment_mode.py`, and the `ingest-config` UI core with its
  Isaacus on/off toggle and e2e spec. A toggle that disengages a hard dependency
  offers the operator a choice that produces a broken deployment.
- `docs/architecture.md` §2, §7.1, §7.2 and §8 already describe this posture;
  they cited an amendment that had not been written. This is that amendment, and
  those citations are now accurate.
- Air-gapped operation is a **non-goal**. Reinstating it would require replacing
  the retrieval leg with a local embedding model — a different architecture, and
  its own ADR superseding this one.
