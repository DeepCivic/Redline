# redline — Comprehension Lens Design

> **Status:** Draft for review · **Date:** 2026-07-24
> **Supersedes:** [`procurement-evaluation-plan.md`](./procurement-evaluation-plan.md)
> (deprecated; retained as delivery history for Threads 1–11).
>
> This is the living delivery document. It carries the new **comprehension lens**
> track *and* the outstanding procurement scope the old plan had not yet built.

---

## 1. Why this document exists

The build plan sequenced a procurement vertical: ingest → classify → cost →
review grid → pivots → Excel. Threads 1–11 are built and green. Threads 12–16
remain.

Reading the upstream systems we depend on — **Numbatch** (DeepCivic/Numbatch)
and **womblex** (DeepCivic/womblex) — surfaced three findings that change the
design, not just the roadmap. Two of them are conflicts between what we intend
to build and what the engines actually do.

### Finding 1 — we modelled requirements one tier too shallow

Numbatch is built on a deliberate **two-tier** split (`docs/DATA_MODEL.md`):

| Tier | Tables | Lifetime |
|---|---|---|
| **Library** | `topics`, `topic_samples`, `feedback_corrections` | durable, org-scoped, shared across profiles |
| **Bundle** | `profiles`, `profile_topics`, `profile_samples` | disposable, per-use |
| **Results** | `chunk_classifications`, `document_classifications` | ephemeral (30-day purge) |

redline's `Requirement` + `RequirementSet` (`packages/redline-domain/src/entities/requirement.ts`)
is a flattened projection of **one profile, scoped to one evaluation**. The
adapter seam is `NumbatchProfileBinding { profileId, strategy, topicToRequirement }`
(`packages/redline-adapters/src/numbatch/numbatch-classifier.ts:52`), rebuilt per
evaluation by `services/numbatch/bootstrap-profile.py`.

Consequences of the flattening:

- **No library.** No topic outlives an evaluation. Every evaluation re-authors
  its criteria from scratch.
- **No samples in the domain.** Curated example passages — the semantic signal
  Numbatch actually trains on — exist only transiently inside the bootstrap
  script. The domain models a requirement as prose `definition` alone.
- **No correction loop.** Numbatch's `feedback_corrections` +
  corrections-as-sample-membership (upstream ADR-0020) has no redline
  counterpart, so a reviewer's judgement cannot compound.

The durable, reusable asset we want is not new work. **It is the tier we
discarded.**

### Finding 2 — the retrieval leg exists, in womblex, not Numbatch

Numbatch has **no embeddings, no vector store, no nearest-neighbour** — verified
by search across `backend/`, `inference/`, and `docs/` (only
`max_position_embeddings` in a test config and "label vectors" in prose). Its
pipeline is chunks → LoRA adapter → roll-up.

womblex has a complete embedding stage:

- `src/womblex/analyse/embed_stage.py` — *"Consumes `*.chunks.parquet` … writes a
  `*.embeddings.parquet` sibling per batch — one vector per chunk, joinable back
  on `(source_hash, chunk_index, content_type)`. Chunks are the right granularity
  for retrieval."*
- `EMBEDDINGS_SCHEMA`, `embeddings_path_for()` — `src/womblex/store/output.py:168`
- A first-class composable operation: `embed(chunks) → list[Embedding]`

redline already runs a womblex sidecar over those shards. **Retrieval is a shard
we are not yet reading, not a service to build.**

### Finding 3 — the zero-example promise collides with the training floor

`MIN_SAMPLES_PER_TOPIC = 10` (`backend/app/models/profile.py:23`), enforced at
train time (`backend/app/services/training_jobs.py:85`: *"Every topic needs at
least 10 unique samples"*). A definition-only profile **cannot be trained**.

Any workflow promising "write a definition paragraph, get a mapped corpus, no
examples" therefore cannot reach Numbatch's classifier on its first pass. This is
the single most consequential constraint in the design, and §4 resolves it.

---

## 2. What we are building

A **comprehension lens**: the user defines a handful of topics, the system sorts
the obvious documents silently, surfaces only genuine collisions, and remembers
the resolutions as reusable boundary logic.

The workflow, in the user's terms:

1. **Define topics** — 2–10 topics, each a name + definition paragraph, plus
   optional **hard rules** (`SEC-* → Security`).
2. **Map the corpus** — hard rules first, then retrieval against topic
   definitions, then LLM adjudication for what remains unclear.
3. **Resolve collisions** — a bounded set (≤20) of genuinely ambiguous documents,
   as multiple-choice: primary / secondary / split.
4. **Save the lens** — topic definitions + hard rules + boundary decisions
   persist. The corpus classification is disposable.

The lens is the durable asset. Everything else is disposable infrastructure.

### Relationship to procurement

Procurement evaluation becomes the **first vertical over the lens**, not a
separate machine. A procurement *requirement* is a lens *topic*; a
`RequirementSet` is a lens bound to an evaluation. The review grid, pricing
pivots, and Excel export (Threads 12–14) sit on top unchanged.

> **Decision D1 — scope.** redline is a corpus-comprehension lens that serves
> procurement, not a procurement-only adapter. *Consequence:* `CLAUDE.md`'s
> "Procurement Evaluation Adapter" identity is updated. *To flip:* keep the lens
> internal to the evaluation flow and drop the general-corpus use case.

---

## 3. Architecture — composable operations, not a pipeline

womblex's composable design is the model we adopt, deliberately and in detail.
Its lessons, and how each lands here:

**Stages communicate through persisted, joinable sidecars — never an
orchestrator.** womblex *had* a stage registry and deleted it
(`docs/composable-design.md:7`: the orchestrator, `STAGE_REGISTRY`,
`_resolve_stages` and `config.stages` "have been removed. Operations are
independent functions that callers compose directly"). *A stage invoked on its
own must not depend on which stages ran before — only on what is on disk.*

→ Lens operations are independent functions over shards joinable on
`source_hash` (+ `chunk_index`). No lens orchestrator. Note the surviving
registries in Numbatch (roll-up strategy, model family) are *strategy selection*,
a different and legitimate pattern.

**The base is verbatim and never rewritten.** *"The extraction shard is verbatim
and never rewritten; every downstream mutation … is a separate sibling parquet."*

→ Classifications and resolutions are additive sibling overlays. A boundary
decision never mutates the extraction record.

**A missing overlay falls back — ordering, not dependency.** `chunk` reuses
`enrich`'s sidecar when present and self-enriches when absent.

→ **This resolves Finding 3.** The trained Numbatch adapter is an *optional
overlay*, not a required stage (§4).

**Content-addressed identity makes reuse a cache hit by construction.**
`source_hash = sha256(record_id + text)` — *"re-ingesting an unchanged record
yields the same hash, and its existing … sidecars still join."*

→ Boundary decisions are keyed on content hash, so a decision re-attaches
automatically when the same document appears in a different corpus. **This is the
mechanism by which the lens compounds**, rather than a promise that it does.

**Enforcement is pragmatic.** A disabled stage passes through unchanged; a
per-document gap is skipped; only genuine misuse raises; structural
impossibilities *"fail naturally at the type boundary."*

→ Sharpens redline's Result semantics: a skipped document is not a
`DomainError`. Currently unstated in our ports.

**Signals are a named, statused register.** `docs/heuristics_disambiguation.md`
lists each heuristic with its implementing symbol and implemented/not-implemented
status.

→ The ambiguity signals driving Clear/Ambiguous get the same treatment, rather
than an opaque threshold.

### The classification path

```
documents
   │
   ├─ hard rules ───────────────► assigned (deterministic, no model)
   │   (SEC-*, CVE-*)
   │
   ├─ retrieval ────────────────► clear match
   │   womblex *.embeddings.parquet
   │   nearest-neighbour vs topic definitions
   │
   ├─ LLM adjudication ─────────► clear match + one-sentence rationale
   │   (only what retrieval left unclear)
   │
   └─ ambiguous ────────────────► user resolves (bounded, ≤20)
                                      │
                                      ▼
                             boundary decision
                        (content-addressed, durable)
                                      │
                                      ▼
                        accumulates as topic samples
                                      │
                                      ▼
                   ┌──── ≥10 samples/topic ────► Numbatch adapter
                   │                              trains + engages
                   └──── below floor ───────────► overlay stays off
```

Hard rules bypassing the model has direct precedent: womblex's register ingests
(G-NAF, ABN, geospatial) *"produce Parquet directly and … bypass the NLP
pipeline. This is by design."*

---

## 4. The cold-start resolution

> **Decision D2 — cold start.** The trained Numbatch adapter is an **optional
> overlay**. The lens's first pass runs hard rules → retrieval → LLM
> adjudication, with no trained adapter and no curated samples. As boundary
> decisions accumulate into topic samples and a topic crosses
> `MIN_SAMPLES_PER_TOPIC`, the adapter is trained and engages for subsequent
> runs. *To flip:* relax the floor in the fork (a **non-additive** fork change,
> contradicting ADR-0005), or require ~10 examples up front and drop the
> zero-example promise.

Why this is the right call rather than a workaround:

- It is womblex's own composable-fallback idiom, applied unchanged.
- It preserves **ADR-0005**'s additive-only fork posture — no upstream constraint
  is weakened.
- It makes the first pass *fast*, which the workflow requires. Training a LoRA
  adapter is minutes-to-hours on GPU; "map the corpus" cannot wait on it.
- It degrades honestly: with no samples the lens is a retrieval-and-LLM sorter;
  with accumulated judgement it becomes a trained classifier. Same interface.

Consequence to accept: two classification paths exist, and their outputs must be
interchangeable at the port boundary. `RequirementClassification` already carries
`{ documentId, requirementId, confidence, sourceChunkId }` — the overlay path and
the first-pass path both produce it.

---

## 5. Where the lens lives

> **Decision D3 — system of record.** Numbatch's org-scoped library
> (`topics`, `topic_samples`, `feedback_corrections`) is canonical. redline
> persists lens **references and bindings** only, not copies. *To flip:* mirror
> into `redline_` tables and accept a two-way sync.

Rationale: it honours ADR-0005's "bootstrap via API, no DB seeds", avoids a
duplicate source of truth, and inherits upstream's dedupe guarantees
(`uq_topic_samples_provenance` on `(topic_id, source_doc_id, chunk_id)`) for free.

Cost to accept: lens availability is coupled to the fork running. Mitigated
because the first-pass path (§4) does **not** require Numbatch — only the overlay
does. A lens is definable, usable and improvable with the fork down; only adapter
training and trained inference need it.

Open sub-question (→ ADR): Numbatch's library is `organisation_id`-scoped
(upstream ADR-0003) while redline inherits Wayfinder identity (ADR-0006). The
tenancy mapping needs a decision before the lens is shared between users.

---

## 6. Delivery

Threads continue the existing monotonic numbering. Each is independently
buildable, testable, and carries an explicit exit test.

### Track L — Comprehension lens (new)

- **Thread 17 — Lens domain: `Topic`, `Lens`, `HardRule`.** Pure `redline-domain`
  entities, zero deps, tests-first. `Lens` is durable and evaluation-independent;
  `RequirementSet` becomes a projection of a lens bound to an evaluation. Hard
  rules are pattern → topic, evaluated before any model.
  _Exit: lens/topic/hard-rule invariants covered; a lens round-trips independent
  of any evaluation; `RequirementSet` still satisfies its ≤10 cap; `./validate.sh`
  green incl. purity check #4._

- **Thread 18 — Embeddings read seam.** The womblex sidecar exposes
  `*.embeddings.parquet` across the JSON boundary (extends ADR-0003); a
  `redline-adapters` reader implements a new `IEmbeddingReader` port. Decide the
  vector wire representation — JSON float arrays are the naive option and may not
  survive corpus scale.
  _Exit: contract test reads real vectors from a captured sidecar payload,
  joinable on `(source_hash, chunk_index)`; TS still links no Parquet reader._

- **Thread 19 — First-pass classification.** Hard rules → retrieval
  nearest-neighbour → LLM adjudication, composed as independent functions (no
  orchestrator). Produces `RequirementClassification[]` plus a one-sentence
  rationale per assignment.
  _Exit: a fixture corpus classifies end-to-end with **no trained adapter and no
  curated samples**; hard-rule hits never reach the model; every assignment
  carries a rationale._

- **Thread 20 — Clear/Ambiguous + Document Map.** A pure derivation over
  classifications into Clear/Ambiguous buckets, driven by a named, statused
  signal register; the Document Map is a derived read model (never stored state),
  reusing Wayfinder's `computePivot`.
  _Exit: map percentages match hand-computed totals on a fixture; no confidence
  score reaches the view model; the map is recomputed, never persisted._

- **Thread 21 — Collisions & boundary decisions.** Deterministic selection,
  ordering and capping of the ambiguous set (≤20); resolution as
  primary/secondary/split; decisions persisted **content-addressed** and applied
  as full-label replacement with global/profile scope and an append-only audit
  (adopting upstream ADR-0020).
  _Exit: a corpus yields a bounded, deterministically-ordered collision set;
  re-resolving is idempotent; a decision made in one evaluation re-attaches to the
  same document content in another._

- **Thread 22 — Lens persistence & portability.** Save/load a lens across
  evaluations; bindings to Numbatch topics; the lens survives the corpus.
  _Exit: a lens saved in one evaluation is applied to a different corpus and its
  boundary decisions still bite._

- **Thread 23 — Lens workflow surface.** Its own stage machine (define → map →
  resolve → save), **not** new `IntakeStage` members — `nextIntakeStage` /
  `canAdvanceIntakeStage` are strictly linear and forcing this in would break
  Thread 11. Framework-free core + collision UI, matching the Thread 11 pattern.
  _Exit: the four-step workflow drives to a saved lens in the pure core; Thread
  11's control surface still passes unchanged._

- **Thread 24 — Overlay engagement & retrain policy.** When accumulated
  decisions cross `MIN_SAMPLES_PER_TOPIC`, train and activate the Numbatch
  adapter (upstream ADR-0021's train → compare → activate); decide who triggers
  it and whether the user ever waits.
  _Exit: a lens crossing the floor trains and engages; subsequent runs use the
  adapter; the first-pass path remains available and interchangeable at the port._

### Track P — Procurement vertical (outstanding, carried from the old plan)

- **Thread 12 — In-app review grid** (priority 1). Sortable/filterable table
  reusing `field-report-view` typed cells; source column deep-links to document
  location.
  _Exit: real evaluation renders; currency sorts numerically; source links resolve._

- **Thread 13 — Pricing pivots.** `computePivot` for per-brand and
  per-requirement rollups; axis selection.
  _Exit: pivot matches hand-computed totals on a fixture._

- **Thread 14 — Excel export** (priority 2). Reuses Wayfinder's XLSX path so
  currency stays numeric; one sheet per table/pivot.
  _Exit: workbook opens with numeric currency + working document links._

### Track H — Shell & hardening

- **Thread 25 — Next.js shell** (was the Track 4 follow-up). React/Next shell
  matching Wayfinder's `apps/web` (ADR-0006) serving
  `/evaluations/:id/grouping` and the lens routes; wires the existing Playwright
  spec (`apps/redline-web/e2e/`) into CI as the executable gate, closing the
  `/e2e` deviation in `CLAUDE.md`.
  _Exit: Playwright runs green in CI against served routes._

- **Thread 15 — Isaacus-optional & air-gap validation.** Prove womblex's
  non-Isaacus path end-to-end; surface as a config toggle. Now also covers the
  lens: the first-pass path must state its own network posture.
  _Exit: full pipeline runs with `ISAACUS_API_KEY` unset._

- **Thread 16 — Workspace extraction & release prep.** Standalone workspace;
  sever the submodule seam; graft the financial overlay onto the vendored fork
  (Threads 6–8 mechanical wiring); CI, compose docs, README.
  _Exit: builds and runs standalone; validate script green._

### Sequencing

Thread 17 → 18 → 19 is the critical path; 19 is where the workflow first becomes
demonstrable without any trained model. Threads 12–14 are independent of the lens
track and can proceed in parallel — the lens changes what feeds the grid, not the
grid itself.

---

## 7. Decision register

| # | Decision | Status | Proposed ADR |
|---|---|---|---|
| D1 | redline is a comprehension lens serving procurement | **assumed** — flip-able | scope ADR |
| D2 | Trained adapter is an optional overlay; first pass needs no samples | **assumed** — flip-able | cold-start ADR |
| D3 | Numbatch's library is the system of record | **assumed** — flip-able | system-of-record ADR |
| D4 | Lens operations are independent functions over joinable sidecars | adopted from womblex | composition ADR |
| D5 | Retrieval is womblex's; redline builds no vector store | settled by Finding 2 | retrieval ADR |
| D6 | Boundary decisions are content-addressed | adopted from womblex | addressing ADR |
| D7 | Base is verbatim; resolutions are additive overlays | adopted from womblex | overlay ADR |
| D8 | Corpus classifications ephemeral; lens durable | adopted from Numbatch | retention ADR |
| D9 | Boundary decisions are corrections-as-sample-membership | adopted from Numbatch ADR-0020 | corrections ADR |
| D10 | Preconditions ride the type boundary; only misuse errors | adopted from womblex | error-semantics ADR |

**D1, D2 and D3 are assumptions, not settled decisions.** They were taken to
unblock this document. Each is stated with its flip condition; flipping D2 or D3
materially changes Threads 19–24.

Amendments the above force on existing ADRs:

- **ADR-0004** — supersede. "User-defined, ≤10" survives; the evaluation-scoped
  lifetime of `RequirementSet` does not.
- **ADR-0003** — amend to carry embeddings across the JSON boundary.
- **ADR-0005** — reaffirmed by D2 (additive-only posture preserved); amend only
  if D2 is flipped to relaxing the training floor.
- **ADR-0006** — amend or extend for Numbatch's `organisation_id` tenancy.

---

## 8. Non-goals

Recorded so they do not creep back thread by thread:

- **No synthetic data probes.** Moving target while the lens is unstable.
- **No autonomous questioning.** Replaced by bounded multiple-choice collisions.
- **No graph visualisations.** Unnecessary for the target use cases.
- **No confidence scores in the UI.** Replaced by Clear/Ambiguous buckets.
- **No lens orchestrator.** Explicitly rejected — womblex deleted theirs.

Re-entry condition: revisit after a lens has accumulated 20+ boundary decisions
in real use.

---

## 9. Open questions

1. **Vector wire format** (Thread 18) — JSON float arrays across the ADR-0003
   boundary may not survive corpus scale. Alternatives: a binary side channel, or
   keeping retrieval server-side in the sidecar and shipping only neighbours.
2. **LLM adjudication seam** — `ILanguageModel.summarise` is procurement-shaped
   (`{ vendorName, productName, passages }`). Adjudication needs a second method
   or a distinct port.
3. **Tenancy mapping** — Numbatch `organisation_id` ↔ Wayfinder identity (§5).
4. **Primary/secondary semantics** — Numbatch returns score-sorted ≤3 topics with
   no primary/secondary distinction; this is net-new modelling in Thread 21.
5. **Ambiguity thresholds** — the signal register (Thread 20) needs initial
   values; no corpus has been measured yet.

---

## 10. Build state

_Update at the end of every thread. Threads 1–11 are complete — their logs remain
in the [deprecated plan](./procurement-evaluation-plan.md) §10 and are not
duplicated here._

| Thread | Track | Status | Notes |
|---|---|---|---|
| 1–11 | — | ✅ **done** | See the deprecated plan's §10 logs (scaffold → workflow manager UI). |
| 17 — Lens domain (`Topic`, `Lens`, `HardRule`) | L | 🔵 **next** | Critical path. Pure domain, tests-first. |
| 18 — Embeddings read seam | L | ⚪ not started | Extends ADR-0003; vector wire format is open question #1. |
| 19 — First-pass classification | L | ⚪ not started | Where the workflow becomes demonstrable with no trained model. |
| 20 — Clear/Ambiguous + Document Map | L | ⚪ not started | Pure derivation; signal register needs initial thresholds. |
| 21 — Collisions & boundary decisions | L | ⚪ not started | Content-addressed; adopts upstream ADR-0020. |
| 22 — Lens persistence & portability | L | ⚪ not started | Depends on D3. |
| 23 — Lens workflow surface | L | ⚪ not started | Own stage machine; must not disturb Thread 11. |
| 24 — Overlay engagement & retrain policy | L | ⚪ not started | Engages Numbatch once the sample floor is crossed. |
| 12 — In-app review grid | P | ⚪ not started | Priority 1 of the procurement vertical; independent of Track L. |
| 13 — Pricing pivots | P | ⚪ not started | |
| 14 — Excel export | P | ⚪ not started | Priority 2. |
| 25 — Next.js shell | H | ⚪ not started | Closes the `/e2e` deviation in `CLAUDE.md`. |
| 15 — Isaacus-optional & air-gap validation | H | ⚪ not started | Now also covers the lens's first-pass network posture. |
| 16 — Workspace extraction & release prep | H | ⚪ not started | Grafts the Threads 6–8 financial overlay onto the vendored fork. |

---

## 11. A note on recording decisions

womblex keeps `docs/decisions.md` — *"decisions and their rejected alternatives,
approaches that were tried and abandoned (so they aren't re-attempted),
library-general limitations, and the deferred backlog"* — corpus-agnostic, with
measured tradeoffs attached.

redline has no equivalent. ADRs record what we chose; they do not record what we
ruled out and why. This repo has already fix-forwarded once (fixed 1–6 →
user-defined criteria) and is fix-forwarding again here at the library tier.
**Adding `docs/decisions.md` in womblex's genre is recommended** — it is what
stops the next session relitigating settled ground.
