# redline — Comprehension Lens Design
# (Dev Iteration 2 — frozen history)

> **Status:** ⚠️ DEPRECATED — frozen delivery history · **Date:** 2026-07-24
> **Supersedes:** [`dev-iteration-1.md`](./dev-iteration-1.md)
> (the original build plan; delivery history for Threads 1–15).
> **Superseded by:** [`dev-iteration-3.md`](./dev-iteration-3.md) — the current living
> delivery document.
>
> This doc introduced the **comprehension lens** track (Threads 17–25, all ✅ done)
> and carried forward the outstanding procurement scope at the time. It is retained
> as the authoritative design rationale (§1–§5, §7 decision register, §8 non-goals)
> and as the delivery history for Threads 17–25. **Do not track new threads here** —
> §6 sequencing and §10 build-state are frozen at the iteration-2 boundary. **No
> outstanding work is tracked in this document**; every item still to be done now
> lives in [`dev-iteration-3.md`](./dev-iteration-3.md). Only the design *rationale*
> remains authoritative here.

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

| Tier        | Tables                                              | Lifetime                                    |
| ----------- | --------------------------------------------------- | ------------------------------------------- |
| **Library** | `topics`, `topic_samples`, `feedback_corrections`   | durable, org-scoped, shared across profiles |
| **Bundle**  | `profiles`, `profile_topics`, `profile_samples`     | disposable, per-use                         |
| **Results** | `chunk_classifications`, `document_classifications` | ephemeral (30-day purge)                    |

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

- `src/womblex/analyse/embed_stage.py` — _"Consumes `*.chunks.parquet` … writes a
  `*.embeddings.parquet` sibling per batch — one vector per chunk, joinable back
  on `(source_hash, chunk_index, content_type)`. Chunks are the right granularity
  for retrieval."_
- `EMBEDDINGS_SCHEMA`, `embeddings_path_for()` — `src/womblex/store/output.py:168`
- A first-class composable operation: `embed(chunks) → list[Embedding]`

redline already runs a womblex sidecar over those shards. **Retrieval is a shard
we are not yet reading, not a service to build.**

### Finding 3 — the zero-example promise collides with the training floor

`MIN_SAMPLES_PER_TOPIC = 10` (`backend/app/models/profile.py:23`), enforced at
train time (`backend/app/services/training_jobs.py:85`: _"Every topic needs at
least 10 unique samples"_). A definition-only profile **cannot be trained**.

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

**Procurement evaluation remains the purpose.** The lens is the _means_: a more
composable design that puts a usable solution in a specialist's hands sooner,
because the sorting loop works before any classifier is trained, before costing,
and before the grid.

A procurement _requirement_ is a lens _topic_; a `RequirementSet` is a lens bound
to an evaluation. The review grid, pricing pivots, and Excel export (Threads
12–14) sit on top unchanged.

> **Decision D1 — scope. SETTLED (2026-07-24).** redline is built in service of
> procurement evaluation; the comprehension lens is the composable architecture
> that delivers it sooner, not a separate product goal. Generalising the lens
> beyond procurement is **not a goal** — it is a property the design happens to
> have, and it is not to be pursued at procurement's expense. _Consequence:_ the
> repo identity stays procurement-first; the lens describes how it is built.

---

## 3. Architecture — composable operations, not a pipeline

womblex's composable design is the model we adopt, deliberately and in detail.
Its lessons, and how each lands here:

**Stages communicate through persisted, joinable sidecars — never an
orchestrator.** womblex _had_ a stage registry and deleted it
(`docs/composable-design.md:7`: the orchestrator, `STAGE_REGISTRY`,
`_resolve_stages` and `config.stages` "have been removed. Operations are
independent functions that callers compose directly"). _A stage invoked on its
own must not depend on which stages ran before — only on what is on disk._

→ Lens operations are independent functions over shards joinable on
`source_hash` (+ `chunk_index`). No lens orchestrator. Note the surviving
registries in Numbatch (roll-up strategy, model family) are _strategy selection_,
a different and legitimate pattern.

**The base is verbatim and never rewritten.** _"The extraction shard is verbatim
and never rewritten; every downstream mutation … is a separate sibling parquet."_

→ Classifications and resolutions are additive sibling overlays. A boundary
decision never mutates the extraction record.

**A missing overlay falls back — ordering, not dependency.** `chunk` reuses
`enrich`'s sidecar when present and self-enriches when absent.

→ **This resolves Finding 3.** The trained Numbatch adapter is an _optional
overlay_, not a required stage (§4).

**Content-addressed identity makes reuse a cache hit by construction.**
`source_hash = sha256(record_id + text)` — _"re-ingesting an unchanged record
yields the same hash, and its existing … sidecars still join."_

→ Boundary decisions are keyed on content hash, so a decision re-attaches
automatically when the same document appears in a different corpus. **This is the
mechanism by which the lens compounds**, rather than a promise that it does.

**Enforcement is pragmatic.** A disabled stage passes through unchanged; a
per-document gap is skipped; only genuine misuse raises; structural
impossibilities _"fail naturally at the type boundary."_

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
(G-NAF, ABN, geospatial) _"produce Parquet directly and … bypass the NLP
pipeline. This is by design."_

---

## 4. The cold-start resolution

> **Decision D2 — cold start. SETTLED (2026-07-24).** The trained Numbatch
> adapter is an **optional overlay**. The lens's first pass runs hard rules →
> retrieval → LLM adjudication, with no trained adapter and no curated samples.
> As boundary decisions accumulate into topic samples and a topic crosses
> `MIN_SAMPLES_PER_TOPIC`, the adapter is trained and engages for subsequent
> runs.
>
> _Rationale of record:_ Numbatch and womblex are resources to be leveraged **to
> their maximum capacity** in service of the intent. This decision does exactly
> that — it uses womblex's embeddings (built, currently unread by redline) and
> Numbatch's trained classification (built, currently reachable only after a
> training floor we cannot clear on day one), rather than weakening either
> engine to fit. No upstream constraint is relaxed and ADR-0005's additive-only
> fork posture is preserved.

Why this is the right call rather than a workaround:

- It is womblex's own composable-fallback idiom, applied unchanged.
- It preserves **ADR-0005**'s additive-only fork posture — no upstream constraint
  is weakened.
- It makes the first pass _fast_, which the workflow requires. Training a LoRA
  adapter is minutes-to-hours on GPU; "map the corpus" cannot wait on it.
- It degrades honestly: with no samples the lens is a retrieval-and-LLM sorter;
  with accumulated judgement it becomes a trained classifier. Same interface.

Consequence to accept: two classification paths exist, and their outputs must be
interchangeable at the port boundary. `RequirementClassification` already carries
`{ documentId, requirementId, confidence, sourceChunkId }` — the overlay path and
the first-pass path both produce it.

---

## 5. Where the lens lives

> **Decision D3 — system of record. SETTLED (2026-07-24), by implication of D1
> and D2.** Numbatch's org-scoped library (`topics`, `topic_samples`,
> `feedback_corrections`) is canonical. redline persists lens **references and
> bindings** only, not copies.
>
> _Reasoning:_ D2 commits to leveraging Numbatch to its maximum capacity, and D1
> keeps procurement — not lens infrastructure — as the purpose. Mirroring the
> library into `redline_` tables would rebuild machinery Numbatch already
> provides, add a two-way sync, and spend procurement delivery time on it. The
> library stays where it is already correct.

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

### Sequencing

Thread 17 → 18 → 19 is the critical path; 19 is where the workflow first becomes
demonstrable without any trained model. Threads 12–14 are independent of the lens
track and can proceed in parallel — the lens changes what feeds the grid, not the
grid itself.

### The thread contract (non-negotiable)

A **thread is one build step**, sized to fit a single agent's context:

- **One build step, including its test.** If the exit test needs two unrelated
  things built first, it is two threads.
- **One agent, one context.** A thread must be completable without the agent
  re-reading half the repo. If planning it requires spanning packages _and_
  languages _and_ a new seam, split it.
- **One commit.** A PR is opened **only on explicit user request**.
- **Tests-first.** The test file is written before the implementation file.
- **One package where possible.** A thread crossing a package boundary needs a
  reason; a thread crossing three does not exist — it is three threads.

This is the guard against token bloat spanning build tasks. Threads below are
sliced to it, which is why there are more of them and each is smaller.

Threads continue the existing monotonic numbering. Each carries an explicit exit
test.

### Track L — Comprehension lens (new)

**Lens domain (pure `redline-domain`, zero deps)**

- **Thread 17 — `Topic` + `Lens` entities.** Durable and
  evaluation-independent; `RequirementSet` becomes a projection of a lens bound
  to an evaluation.
  _Exit: lens/topic invariants covered; a lens constructs with no `evaluationId`;
  `RequirementSet` still satisfies its ≤10 cap; purity check #4 green._
  — docs: [thread-17](./threads/thread-17-topic-and-lens-entities.md)

- **Thread 18 — `HardRule` entity + pure evaluation.** Pattern → topic,
  match semantics, precedence when two rules hit.
  _Exit: rule-match invariants covered incl. precedence and no-match; pure, no I/O._
  — docs: [thread-18](./threads/thread-18-hard-rule-entity-and-evaluation.md)

**Retrieval seam**

- **Thread 19 — Sidecar embeddings read endpoint** (Python, `womblex-ingest`).
  Serves `*.embeddings.parquet` over the JSON boundary; settles the vector wire
  representation (open question #1).
  _Exit: pytest reads real vectors for a document, joinable on
  `(source_hash, chunk_index)`; absent shard → `NOT_FOUND`._
  — docs: [thread-19](./threads/thread-19-sidecar-embeddings-endpoint.md)

- **Thread 20 — `IEmbeddingReader` port + adapter** (TS). Parses into
  `Float32Array` and caches per evaluation — the two constraints cloud hosting
  imposes on shipping vectors (ADR-0014), binding rather than advisory.
  _Exit: contract test against a captured sidecar payload; error taxonomy covered;
  TS still links no Parquet reader._
  — docs: [thread-20](./threads/thread-20-embedding-reader.md)

- **Thread 20a — Sidecar text-embedding endpoint** (Python, `womblex-ingest`).
  Embeds arbitrary text in the _same_ space as the document vectors, so a topic
  definition can be matched against them. Surfaced by ADR-0014: redline's
  TypeScript has no embedding model, so shipping chunk vectors does not by itself
  give Thread 22 a comparable query vector. **Thread 22's dependency, not Thread
  20's** — 20 reads document vectors and needs nothing from this.
  _Exit: pytest embeds text and gets a vector whose `model` and `dimensions` match
  the document embeddings' declaration; the same text embeds identically twice._
  — docs: [thread-20a](./threads/thread-20a-sidecar-text-embedding-endpoint.md)

**First-pass classification** (each stage an independent function — no orchestrator)

- **Thread 21 — Hard-rule pre-pass.** Rules resolve before any model; claimed
  documents never reach the classifier.
  _Exit: rule-claimed documents produce classifications with the model port
  unused (fake asserts zero calls)._
  — docs: [thread-21](./threads/thread-21-hard-rule-pre-pass.md)

- **Thread 22 — Retrieval classification.** Nearest-neighbour of chunk vectors
  against topic definitions. Needs both 20 (the chunk vectors) and 20a (the query
  vector).
  _Exit: a fixture corpus classifies with no trained adapter and no samples._
  — docs: [thread-22](./threads/thread-22-retrieval-classification.md)

- **Thread 23 — LLM adjudication + rationale.** Only for what retrieval left
  unclear; emits the one-sentence rationale. Adds the adjudication seam
  (open question #2).
  _Exit: adjudicated assignments carry a rationale; the seam is a port, exercised
  with a fake._
  — docs: [thread-23](./threads/thread-23-llm-adjudication-and-rationale.md)

**Comprehension read models (pure)**

- **Thread 24 — Ambiguity signal register + Clear/Ambiguous derivation.**
  Named, statused signals in womblex's `heuristics_disambiguation.md` shape.
  _Exit: bucketing covered per signal; no confidence value escapes to the view model._
  — docs: [thread-24](./threads/thread-24-ambiguity-signals-and-buckets.md)

- **Thread 25 — Document Map read model.** Derived, never stored; reuses
  `computePivot`.
  _Exit: percentages match hand-computed totals on a fixture; recomputed, not persisted._
  — docs: [thread-25](./threads/thread-25-document-map-read-model.md)

**Collisions & boundary decisions**

- **Thread 26 — Collision selection, ordering and capping.** Bounded ≤20,
  deterministic.
  _Exit: same corpus yields the same bounded, ordered set; cap holds._

- **Thread 27 — `BoundaryDecision` entity.** Content-addressed;
  primary/secondary/split (net-new modelling — Numbatch has no primary/secondary).
  _Exit: decision invariants covered; the same document content yields the same key._

- **Thread 28 — Boundary decision persistence + corrections push.** Full-label
  replacement with scope and append-only audit (upstream ADR-0020).
  _Exit: re-resolving is idempotent; a decision re-attaches to the same content in
  another evaluation._

**Lens lifecycle**

- **Thread 29 — Lens persistence.** `redline_` tables for the lens + its
  Numbatch bindings (per D3, references not copies).
  _Exit: a lens round-trips; migration idempotent._

- **Thread 30 — Lens portability.** Apply a saved lens to a different corpus.
  _Exit: a lens saved in one evaluation classifies another and its boundary
  decisions still bite._

- **Thread 31 — Lens stage machine** (pure). Define → map → resolve → save, its
  own machine — **not** new `IntakeStage` members.
  _Exit: the four steps drive to a saved lens; Thread 11's control surface passes
  unchanged._

- **Thread 32 — Collision resolution surface.** View model + controller in the
  Thread 11 framework-free pattern.
  _Exit: a collision set resolves through the pure core; view model carries no
  confidence._

**Overlay engagement**

- **Thread 33 — Sample accrual.** Boundary decisions become Numbatch topic
  samples with provenance.
  _Exit: decisions land as samples; upstream dedupe makes re-push a no-op._

- **Thread 34 — Train/activate policy.** Crossing `MIN_SAMPLES_PER_TOPIC`
  triggers train → activate (upstream ADR-0021); the user never blocks on it.
  _Exit: a lens crossing the floor engages the adapter; the first-pass path stays
  interchangeable at the port._

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

- **Thread 36 — Real womblex binding** (next). Implement `RealWomblexExtractor`
  and `RealWomblexTextEmbedder` against the actual womblex Python API — the
  engine every consumer since Thread 4 has only ever seen as a stub. Resolves the
  `womblex` extra to the concrete fork, honours the Parquet→JSON mapping pinned
  in `records.py`, and proves Thread 22's retrieval sorts a _real_ corpus. womblex
  is a **required** dependency, not optional; the stub is a test double, and its
  space is by its own admission "not semantically meaningful". **Precedes Thread
  16** — the engine must run before release is prepped.
  _Exit: `WOMBLEX_MODE=real` ingests a real document, `/embeddings/...` declares
  womblex's real model, `/embeddings/query` matches that space, and
  `ClassifyByRetrieval` sorts a real fixture corpus onto expected topics; runs
  with `ISAACUS_API_KEY` unset._
  — docs: [thread-36](./threads/thread-36-real-womblex-binding.md)

- **Thread 35 — Next.js shell** (was the Track 4 follow-up). React/Next shell
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
  sever the remaining vendoring seam (ADR-0012 pinned it and made it optional);
  graft the financial overlay onto the vendored fork
  (Threads 6–8 mechanical wiring); CI, compose docs, README.
  _Exit: builds and runs standalone; validate script green._



---

## 7. Decision register

| #   | Decision                                                                 | Status                                                | Proposed ADR                                                                                |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| D1  | Procurement is the purpose; the lens is the composable means             | ✅ **settled** 2026-07-24                             | [ADR-0007](./adr/0007-procurement-purpose-lens-means.adr.md) ✅                             |
| D2  | Trained adapter is an optional overlay; first pass needs no samples      | ✅ **settled** 2026-07-24                             | [ADR-0008](./adr/0008-trained-classifier-is-an-optional-overlay.adr.md) ✅                  |
| D3  | Numbatch's library is the system of record                               | ✅ **settled** 2026-07-24 (implied by D1+D2)          | [ADR-0009](./adr/0009-numbatch-library-is-system-of-record.adr.md) ✅                       |
| D4  | Lens operations are independent functions over joinable sidecars         | adopted from womblex                                  | composition ADR                                                                             |
| D5  | Retrieval is womblex's; redline builds no vector store                   | settled by Finding 2                                  | retrieval ADR                                                                               |
| D6  | Boundary decisions are content-addressed                                 | adopted from womblex                                  | addressing ADR                                                                              |
| D7  | Base is verbatim; resolutions are additive overlays                      | adopted from womblex                                  | overlay ADR                                                                                 |
| D8  | Corpus classifications ephemeral; lens durable                           | adopted from Numbatch                                 | retention ADR                                                                               |
| D9  | Boundary decisions are corrections-as-sample-membership                  | adopted from Numbatch ADR-0020                        | corrections ADR                                                                             |
| D10 | Preconditions ride the type boundary; only misuse errors                 | adopted from womblex                                  | error-semantics ADR                                                                         |
| D11 | A topic's identity carries into the requirement it projects to           | ✅ **settled** 2026-07-25 (discovered in Thread 17)   | [ADR-0010](./adr/0010-topic-identity-carries-into-the-requirement-projection.adr.md) ✅     |
| D12 | Hard-rule precedence is specificity, then declaration order              | ✅ **settled** 2026-07-25 (discovered in Thread 18)   | [ADR-0011](./adr/0011-hard-rule-precedence-is-specificity-then-declaration-order.adr.md) ✅ |
| D13 | Embeddings cross the JSON boundary as float arrays on a sibling resource | ✅ **settled** 2026-07-25 (precondition to Thread 19) | [ADR-0014](./adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) ✅         |

**D1, D2 and D3 were settled by the project owner on 2026-07-24** and are no
longer assumptions. D1 was settled with a correction to how it had been drafted:
procurement is the purpose and the lens is the means, not the reverse — so the
repo's identity stays procurement-first, and generalising the lens beyond
procurement is explicitly not a goal. Threads 17–34 may now be built against all
three without re-confirmation. D4–D10 are adopted from upstream and recorded
rather than debated.

D1–D3 are now recorded as **track-level ADRs** ([0007](./adr/0007-procurement-purpose-lens-means.adr.md),
[0008](./adr/0008-trained-classifier-is-an-optional-overlay.adr.md),
[0009](./adr/0009-numbatch-library-is-system-of-record.adr.md)) — written once
because they gate Threads 17–34 and belong to no single thread. Every remaining
decision follows the just-in-time model: drafted with the thread that needs it,
reviewed, approved, then built.

**D11 is the first decision this track discovered rather than planned.** Writing
Thread 17's projection forced a question ADR-0009 had left open — whether a
projected requirement keeps its topic's id — and the answer is load-bearing for
the Thread 29 binding, the Thread 33 corrections push, and Thread 30's
cross-corpus re-attachment. It was recorded in Thread 17's own commit, per the
retrospective half of the ADR model.

**D12 is the second.** Thread 18's scope named "precedence when two rules hit"
without settling it; writing the evaluation forced the answer, and it governs
every consumer of the hard-rule stage from Thread 21 on. Recorded in Thread 18's
own commit, same model.

**D13 returns to the precondition model.** Unlike D11 and D12 it was drafted
_before_ Thread 19 was built and approved first, because the answer decided
whether Threads 20 and 22 could exist in TypeScript at all — the one genuinely
irreversible option (server-side retrieval) would have moved nearest-neighbour
into the sidecar. Two things sharpened it during review and are recorded in
ADR-0014 rather than lost: cloud hosting makes `Float32Array` parsing and
per-evaluation caching **binding constraints on Thread 20**, not optimisations;
and shipping vectors does not by itself give Thread 22 a comparable query vector,
so the sidecar still owes a text-embedding endpoint. The rejection of server-side
retrieval rests on Thread 22's exit-gate testability, not on an architectural
objection — the ADR says so explicitly, because the architectural case was
overstated in its first draft.

Amendments the above force on existing ADRs:

- **ADR-0004** — **amended by ADR-0009** (done). "User-defined, ≤10" survives;
  the evaluation-scoped lifetime of `RequirementSet` does not.
- **ADR-0003** — **amended by ADR-0014** (done). The JSON boundary and the
  Parquet-free TypeScript surface survive; "one document-scoped resource" does
  not — the seam is now `/extractions` plus its `/embeddings` sibling.
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

1. ~~**Vector wire format** (Thread 19)~~ — **settled 2026-07-25 by
   [ADR-0014](./adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md)**:
   plain JSON float arrays on a sibling document-scoped resource, L2-normalised,
   declaring the producing model. Both alternatives stay reachable _additively_ on
   the same resource, so the re-entry condition is a measured corpus — revisit
   above ~50k chunks, or if the sidecar and app land in different regions.
2. ~~**LLM adjudication seam**~~ — **settled 2026-08-07 by
   [Thread 23](./threads/thread-23-llm-adjudication-and-rationale.md)**: a
   _distinct_ port, `IAdjudicator`, not a second method on `ILanguageModel`.
   `ILanguageModel.summarise` is procurement-shaped
   (`{ vendorName, productName, passages }`) and shape-coupled to the review-grid
   summary; adjudication is a lens concern with a different input (candidate
   topics) and output (a chosen topic + rationale), so it gets its own seam per
   the composable-operations design (D4).
3. **Tenancy mapping** — Numbatch `organisation_id` ↔ Wayfinder identity (§5).
4. **Primary/secondary semantics** — Numbatch returns score-sorted ≤3 topics with
   no primary/secondary distinction; this is net-new modelling in Thread 21.
5. **Ambiguity thresholds** — the signal register (Thread 24) needs initial
   values; no corpus has been measured yet.

---

## 10. Build state

_These logs are frozen history. Threads 1–11 are in the [first-iteration plan](./dev-iteration-1.md) §10; remaining work is in [`dev-iteration-3.md`](./dev-iteration-3.md)._

| Thread                                  | Track | Package(s)            | Status         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ----- | --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–11                                    | —     | —                     | ✅ **done**    | See the deprecated plan's §10 logs (scaffold → workflow manager UI).                                                                                                                                                                                                                                                                                                                                                                                                  |
| 17 — `Topic` + `Lens` entities          | L     | domain                | ✅ **done**    | Durable tier restored; lens has no `evaluationId`. Locked [ADR-0010](./adr/0010-topic-identity-carries-into-the-requirement-projection.adr.md). [thread-17](./threads/thread-17-topic-and-lens-entities.md)                                                                                                                                                                                                                                                           |
| 18 — `HardRule` + evaluation            | L     | domain                | ✅ **done**    | Deterministic pre-model stage; a gap is an outcome, not an error. Locked [ADR-0011](./adr/0011-hard-rule-precedence-is-specificity-then-declaration-order.adr.md). [thread-18](./threads/thread-18-hard-rule-entity-and-evaluation.md)                                                                                                                                                                                                                                |
| 19 — Sidecar embeddings endpoint        | L     | womblex-ingest        | ✅ **done**    | Vectors ship as JSON floats on a sibling resource, absent independently of the extraction. Locked [ADR-0014](./adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) (precondition), closing open question #1. [thread-19](./threads/thread-19-sidecar-embeddings-endpoint.md)                                                                                                                                                                          |
| 20 — `IEmbeddingReader` + adapter       | L     | domain, adapters      | ✅ **done**    | Vectors reach TS as `Float32Array`, cached per `(evaluation, document)` — both binding per [ADR-0014](./adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md); no new ADR. adapters **58** (+12), domain **97** (+2). [thread-20](./threads/thread-20-embedding-reader.md)                                                                                                                                                                              |
| 20a — Sidecar text-embedding endpoint   | L     | womblex-ingest        | ✅ **done**    | Query vectors embed in the same space as chunk vectors (same `model`/`dimensions`, L2-normalised); implements the gap [ADR-0014](./adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) named, no new ADR. Blocks 22, needs nothing from 20. [thread-20a](./threads/thread-20a-sidecar-text-embedding-endpoint.md)                                                                                                                                     |
| 21 — Hard-rule pre-pass                 | L     | application           | ✅ **done**    | Deterministic first stage: composes Thread 18's `evaluateHardRules`, claims never reach the model (fake asserts zero calls), both paths emit the same `RequirementClassification` (D2). No new ADR. application **24** (+8). [thread-21](./threads/thread-21-hard-rule-pre-pass.md)                                                                                                                                                                                   |
| 22 — Retrieval classification           | L     | application, adapters | ✅ **done**    | Model-free first pass: chunk vectors ranked against topic definitions by cosine similarity (a dot product — vectors cross L2-normalised, ADR-0014). Carries the query-side seam Thread 20a's endpoint lacked in TS (`ITextEmbedder` + `WomblexTextEmbedder`); both paths emit the same `RequirementClassification` (D2). No new ADR. domain **99** (+2), adapters **69** (+11), application **33** (+9). [thread-22](./threads/thread-22-retrieval-classification.md) |
| 23 — LLM adjudication + rationale       | L     | domain, application   | ✅ **done**    | Distinct `IAdjudicator` port (settles open question #2), not a second `ILanguageModel` method; adjudicated rows carry a rationale _alongside_ the shared `RequirementClassification` shape (D2), chosen topic id = requirement id (ADR-0010). Model-hallucinated / no-choice inputs refuse. No new ADR. domain **101** (+2), application **41** (+8). [thread-23](./threads/thread-23-llm-adjudication-and-rationale.md)                                              |
| 24 — Ambiguity signals + buckets        | L     | domain                | ✅ **done**    | Named, statused signal register (womblex's `heuristics_disambiguation` shape — implemented + not-implemented listed) drives a pure Clear/Ambiguous derivation; no confidence value escapes the read model (non-goal §8). Two signals wired (`no-clear-leader`, `close-contenders`), two declared-inert. Thresholds unmeasured (open question #5). No new ADR. domain **123** (+22). [thread-24](./threads/thread-24-ambiguity-signals-and-buckets.md)                    |
| 25 — Document Map read model            | L     | application           | ✅ **done**    | Derived, never stored: a pure roll-up of how the corpus sorted — per-topic counts + shares and the corpus-wide Clear/Ambiguous split. Reuses `computePivot`'s count-measure algorithm (descending count, alphabetical tiebreak) over redline's own `MappedDocument`, not its types (Thread 13's precedent); parity against the real `computePivot` is frozen in the adapters' Wayfinder contract test. No confidence value enters or escapes (non-goal §8). No new ADR. application **50** (+9), adapters **70** (+1, the count-pivot parity). [thread-25](./threads/thread-25-document-map-read-model.md) |
| 26 — Collision selection & capping      | L     | domain                | ⚪ not started | Was next on Track L; deferred behind Thread 36 (real womblex binding) at the owner's direction — the required engine must run before more lens work stacks on the stub.                                                                                                                                                                                                                                                                                              |
| 27 — `BoundaryDecision` entity          | L     | domain                | ⚪ not started | Net-new modelling (open question #4).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 28 — Decision persistence + corrections | L     | adapters              | ⚪ not started | Upstream ADR-0020.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 29 — Lens persistence                   | L     | adapters              | ⚪ not started | Depends on D3.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 30 — Lens portability                   | L     | application           | ⚪ not started | The compounding proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 31 — Lens stage machine                 | L     | redline-web           | ⚪ not started | Must not disturb Thread 11.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 32 — Collision resolution surface       | L     | redline-web           | ⚪ not started |                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 33 — Sample accrual                     | L     | adapters              | ⚪ not started |                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 34 — Train/activate policy              | L     | adapters              | ⚪ not started | Engages the overlay.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 12 — In-app review grid                 | P     | redline-web           | ⚪ not started | Priority 1; independent of Track L.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 13 — Pricing pivots                     | P     | application           | ⚪ not started |                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 14 — Excel export                       | P     | adapters              | ⚪ not started | Priority 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 36 — Real womblex binding               | H     | womblex-ingest        | 🔵 **next**    | Binds the real engine behind the otherwise-complete seam; retires the "stub space is not semantic" caveat (Threads 19/22/24) and proves real-corpus retrieval. womblex is **required**, not optional. Precedes Thread 16. [thread-36](./threads/thread-36-real-womblex-binding.md)                                                                                                                                                                                     |
| 35 — Next.js shell                      | H     | redline-web           | ⚪ not started | Closes the `/e2e` deviation.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 15 — Isaacus-optional & air-gap         | H     | womblex-ingest        | ⚪ not started | Now covers the lens's network posture.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 16 — Workspace extraction & release     | H     | workspace             | ⚪ not started | Grafts the Threads 6–8 overlay onto the fork.                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 11. A note on recording decisions

womblex keeps `docs/decisions.md` — _"decisions and their rejected alternatives,
approaches that were tried and abandoned (so they aren't re-attempted),
library-general limitations, and the deferred backlog"_ — corpus-agnostic, with
measured tradeoffs attached.

redline has no equivalent. ADRs record what we chose; they do not record what we
ruled out and why. This repo has already fix-forwarded once (fixed 1–6 →
user-defined criteria) and is fix-forwarding again here at the library tier.
**Adding `docs/decisions.md` in womblex's genre is recommended** — it is what
stops the next session relitigating settled ground.
