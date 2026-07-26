# redline — Delivery Plan (Dev Iteration 3)

> **Status:** Living delivery document · **Date:** 2026-08-08
> **Supersedes:** [`dev-iteration-2.md`](./dev-iteration-2.md) (comprehension-lens
> design) and, transitively, [`dev-iteration-1.md`](./dev-iteration-1.md) (original
> build plan).
>
> **This is now the single source of truth for outstanding work.** The two earlier
> documents are frozen history: iteration 1 holds the Thread 1–15 logs, iteration 2
> holds the Thread 17–25 logs and the design rationale (§1–§5), decision register
> (§7) and non-goals (§8) that remain **in force**. This document does not restate
> that rationale — it references it — and carries only the work still to be done,
> resequenced into logical execution order.

---

## 1. Why this document exists

The project has fix-forwarded its plan twice, and the thread numbers grew
monotonically-by-creation across both. The result read illogically: completed and
outstanding threads interleaved, and the last-created thread (real womblex binding)
carried the highest number despite being the immediate next step.

Rather than renumber threads already built, committed, and referenced from
production source, shell scripts and PR history — which would be destructive churn
for cosmetic gain — this iteration **starts a fresh, sequential thread numbering for
the remaining work only**. Completed threads keep their historical numbers and
filenames as an immutable record; new work is numbered **from Thread 37 upward** in
the order it will actually be executed.

**Nothing about the architecture or the settled decisions changes here.** The design
rationale, the decision register (D1–D13, ADR-0001…0014) and the non-goals all live
in [`dev-iteration-2.md`](./dev-iteration-2.md) and remain authoritative. This is a
sequencing and bookkeeping document.

### What is already done (not tracked here)

- **Threads 1–15** — scaffold → domain → womblex sidecar → Numbatch fork + financial
  extension → persistence → orchestration → workflow UI → review grid → pricing
  pivots → Excel export → Isaacus-optional/air-gap. Logs: `dev-iteration-1.md` §10.
- **Threads 17–25** — the comprehension-lens domain, retrieval seam, first-pass
  classification (hard-rule / retrieval / adjudication), and the two comprehension
  read models. Logs: `dev-iteration-2.md` §10.

**Threads 38–40 (the review grid, pricing pivots and Excel export) carry an
unresolved status and are therefore tracked here as outstanding work, not assumed
done.** `dev-iteration-1.md` §10 marks them ✅ done with detailed evidence
(redline-web 58/58); `dev-iteration-2.md` §10 relisted them ⚪ not started under
Track P. Both cannot be true. Until that is reconciled *in this document*, they are
outstanding — their first task is a verification step (§4, Track P), and the
reconciliation itself is owned here, not deferred to the frozen docs.

---

## 2. The thread contract (unchanged)

Carried verbatim from `dev-iteration-2.md` §6 — a **thread is one build step**:

- One build step including its test; if the exit test needs two unrelated things
  built first, it is two threads.
- One agent, one context; if planning spans packages *and* languages *and* a new
  seam, split it.
- One commit. A PR is opened **only on explicit user request**.
- Tests-first: the test file is written before the implementation file.
- One package where possible; a thread crossing three packages does not exist — it
  is three threads.

New threads continue the repo's monotonic numbering (next free number is **37**), so
a new thread's number never collides with a historical filename. Each carries an
explicit exit test and a link to its thread doc under [`./threads/`](./threads/).

**All work that is not verifiably complete lives here.** A thread whose completion is
uncertain is outstanding by definition: it is tracked in this document with a status
of 🔷 **needs verification**, and its first task is to confirm (or rebuild) against
its exit test. Nothing outstanding — whether it needs verification or fresh work — is
left to the frozen iteration documents to track.

---

## 3. Old → new number crosswalk

The remaining work, renumbered into execution order. **Old #** is the identifier used
in `dev-iteration-2.md` and any existing thread doc / source comment; **New #** is the
identifier used from here on.

| New # | Old # | Title                                   | Track | Package(s)              |
| ----- | ----- | --------------------------------------- | ----- | ----------------------- |
| 37a   | 36    | womblex pod (test harness)              | H     | womblex-ingest, infra   |
| 37b   | 36    | Real womblex binding                    | H     | womblex-ingest          |
| 38    | 12    | In-app review grid                      | P     | redline-web             |
| 39    | 13    | Pricing pivots                          | P     | application, redline-web|
| 40    | 14    | Excel export                            | P     | redline-web             |
| 41    | 35    | Next.js shell                           | H     | redline-web             |
| 42    | 26    | Collision selection, ordering & capping | L     | domain                  |
| 43    | 27    | `BoundaryDecision` entity               | L     | domain                  |
| 44    | 28    | Decision persistence + corrections push | L     | adapters                |
| 45    | 29    | Lens persistence                        | L     | adapters                |
| 46    | 30    | Lens portability                        | L     | application             |
| 47    | 31    | Lens stage machine                      | L     | redline-web             |
| 48    | 32    | Collision resolution surface            | L     | redline-web             |
| 49    | 33    | Sample accrual                          | L     | adapters                |
| 50    | 34    | Train/activate policy                   | L     | adapters                |
| 51    | 16    | Workspace extraction & release prep     | H     | workspace               |

> **Note on Thread 36's doc.** The already-drafted
> [`thread-36-real-womblex-binding.md`](./threads/thread-36-real-womblex-binding.md)
> is the doc for the real womblex binding, now split into **37a** (package womblex
> as its own pod for local testing — [thread-37a](./threads/thread-37a-womblex-pod.md))
> and **37b** (bind the real extractor/embedder behind the seam —
> [thread-37b](./threads/thread-37b-real-womblex-binding.md)). The split fell out of
> a correction: womblex is a **required subsystem** that belongs in its own
> container (disparate resource profile), not an opt-in extra baked into the API
> image — so standing the pod up and wiring the binding are two build steps.

---

## 4. The plan

### Sequencing rationale

1. **Thread 37 (real womblex binding) is first** and gates the semantic honesty of
   everything downstream. womblex is a **required subsystem** (D5, Finding 2) —
   redline includes it in its deployment or it does not work; every consumer since
   Thread 4 has run only against the stub **test double**, whose space is, by its own
   admission, "not semantically meaningful". Binding the real engine before more lens
   work stacks on the stub is the point of this resequencing. It is **two build
   steps**: **37a** packages womblex as its own pod (a required subsystem with a
   disparate resource profile belongs in its own container, not baked into the API
   image), and **37b** binds the real extractor/embedder behind the seam and reads
   the pod's shards. The stub is retired as a *shipping default* — it remains only
   as the dependency-free test double for CI and the Thread 4 adapter contract.
2. **Threads 38–41 (Track P + the shell)** deliver the demonstrable procurement
   vertical and the route surface the earlier app-logic threads were built against.
   Independent of the lens track. Their status is unresolved across the frozen
   iterations, so each opens with a verification step (below) and is closed here
   regardless of outcome.
3. **Threads 42–50 (Track L resumes)** build collisions → boundary decisions → lens
   lifecycle → overlay engagement, in dependency order.
4. **Thread 51 (workspace extraction & release) is last** by nature — it ships what
   the preceding threads built.

### Track H — real engine first

womblex is a **required subsystem**, not an optional extra: redline ships it (in
its own pod) or it does not work. This is two build steps.

- **Thread 37a — womblex pod (test harness).** Package the real womblex engine as
  its own container (`Dockerfile.womblex`) and wire a `womblex` compose profile
  that runs the real pipeline (extract → chunk → embed) over a corpus and lands
  the `*.elements` / `*.chunks` / `*.embeddings` shards in the shared MinIO. A
  local test harness so the binding + retrieval proof have a real engine to run
  against; production orchestration of the worker is a deployment choice (the seam
  is object storage, ADR-0002). Also retires the "stub is the default lane"
  framing across the docs.
  _Exit: `scripts/thread-37a-womblex-pod.sh` brings the `womblex` profile up over a
  committed corpus and asserts real `*.elements` / `*.chunks` (and, with an Isaacus
  key, `*.embeddings`) shards land under `proc/{eval}/`._
  — docs: [thread-37a](./threads/thread-37a-womblex-pod.md)
- **Thread 37b — Real womblex binding.** Implement `RealWomblexExtractor` and
  `RealWomblexTextEmbedder` against the actual womblex Python API (`run_extraction`
  / `run_chunking` / `embed_shards` / `embed_texts`); honour the Parquet→JSON
  mapping pinned in `records.py`; prove Thread 22's retrieval sorts a *real*
  corpus (the shards 37a produced). Precedes Thread 51.
  _Exit: `WOMBLEX_MODE=real` serves a real document's extraction, `/embeddings/...`
  declares womblex's real model (`kanon-2-embedder`), `/embeddings/query` matches
  that space, and `ClassifyByRetrieval` sorts a real fixture corpus onto expected
  topics._
  — docs: [thread-37b](./threads/thread-37b-real-womblex-binding.md)

### Track P — procurement vertical

> **These three carry a conflicting done-state across the frozen iterations (see §1),
> so they are tracked here as outstanding.** Each begins with a verification step
> against its exit test: if it passes, close the thread with the evidence recorded in
> §6; if it fails or the artifact is absent, complete it. Either way the thread is
> owned and closed here, not in a frozen doc.

- **Thread 38 — In-app review grid** (priority 1). Sortable/filterable table reusing
  `field-report-view` typed cells; source column deep-links to document location.
  _Verify first: does `apps/redline-web`'s `ReviewGrid` + view already satisfy the
  exit test? If so, record evidence; if not, build it._
  _Exit: real evaluation renders; currency sorts numerically; source links resolve._
- **Thread 39 — Pricing pivots.** `computePivot` for per-brand and per-requirement
  rollups; axis selection.
  _Verify first (as Thread 38); complete if the artifact is absent or failing._
  _Exit: pivot matches hand-computed totals on a fixture._
- **Thread 40 — Excel export** (priority 2). Reuses Wayfinder's XLSX path so currency
  stays numeric; one sheet per table/pivot.
  _Verify first (as Thread 38); complete if the artifact is absent or failing._
  _Exit: workbook opens with numeric currency + working document links._

### Track H — the shell

- **Thread 41 — Next.js shell.** React/Next shell matching Wayfinder's `apps/web`
  (ADR-0006) serving `/evaluations/:id/grouping`, the review/pivot/settings routes and
  the lens routes; wires the existing Playwright specs (`apps/redline-web/e2e/`) into
  CI as the executable gate, closing the `/e2e` deviation in `CLAUDE.md`.
  _Exit: Playwright runs green in CI against served routes._

### Track L — comprehension lens resumes

**Collisions & boundary decisions**

- **Thread 42 — Collision selection, ordering and capping.** Bounded ≤20,
  deterministic.
  _Exit: same corpus yields the same bounded, ordered set; cap holds._
- **Thread 43 — `BoundaryDecision` entity.** Content-addressed;
  primary/secondary/split (net-new modelling — Numbatch has no primary/secondary).
  _Exit: decision invariants covered; the same document content yields the same key._
- **Thread 44 — Boundary decision persistence + corrections push.** Full-label
  replacement with scope and append-only audit (upstream ADR-0020).
  _Exit: re-resolving is idempotent; a decision re-attaches to the same content in
  another evaluation._

**Lens lifecycle**

- **Thread 45 — Lens persistence.** `redline_` tables for the lens + its Numbatch
  bindings (per D3, references not copies).
  _Exit: a lens round-trips; migration idempotent._
- **Thread 46 — Lens portability.** Apply a saved lens to a different corpus.
  _Exit: a lens saved in one evaluation classifies another and its boundary decisions
  still bite._
- **Thread 47 — Lens stage machine** (pure). Define → map → resolve → save, its own
  machine — **not** new `IntakeStage` members.
  _Exit: the four steps drive to a saved lens; Thread 11's control surface passes
  unchanged._
- **Thread 48 — Collision resolution surface.** View model + controller in the
  Thread 11 framework-free pattern.
  _Exit: a collision set resolves through the pure core; view model carries no
  confidence._

**Overlay engagement**

- **Thread 49 — Sample accrual.** Boundary decisions become Numbatch topic samples
  with provenance.
  _Exit: decisions land as samples; upstream dedupe makes re-push a no-op._
- **Thread 50 — Train/activate policy.** Crossing `MIN_SAMPLES_PER_TOPIC` triggers
  train → activate (upstream ADR-0021); the user never blocks on it.
  _Exit: a lens crossing the floor engages the adapter; the first-pass path stays
  interchangeable at the port._

### Track H — release

- **Thread 51 — Workspace extraction & release prep.** Standalone workspace; sever the
  remaining vendoring seam (ADR-0012 pinned it and made it optional); graft the
  financial overlay onto the vendored fork (Threads 6–8 mechanical wiring); CI, compose
  docs, README. Depends on Thread 37 having bound the real engine.
  _Exit: builds and runs standalone; validate script green._

---

## 5. Notes for the reader

1. **Threads 38–40 are tracked as outstanding here** (🔷 needs verification), with a
   verification step as their first task (§4, Track P). This is deliberate: work whose
   completion is uncertain is outstanding, and all outstanding work — verification or
   fresh build — is owned by this document, not the frozen iterations.
2. **Thread 36 → 37 doc rename.** The drafted thread doc keeps its `thread-36-…`
   filename with an in-file numbering note; §3 is the crosswalk. Rename to
   `thread-37-…` on pickup if preferred — purely cosmetic.
3. **The design rationale is not restated here.** If a future reader needs the *why*
   (D1–D13, the three findings, the cold-start resolution), it is in
   `dev-iteration-2.md` §1–§8 — kept there deliberately to avoid a third copy drifting.
   Only *rationale* lives there; all *outstanding work* lives here.
4. **Carried-forward open questions** (from `dev-iteration-2.md` §9), now owned here:
   tenancy mapping (#3), primary/secondary semantics (#4, → Thread 43), ambiguity
   thresholds (#5, unmeasured until Thread 37b gives a real corpus).
5. **Air-gap / offline is a non-goal for redline.** womblex is a required
   subsystem, and its embed stage (`kanon-2-embedder`) is Isaacus-only — so
   retrieval requires a live `ISAACUS_API_KEY`. A deployment without Isaacus
   cannot retrieve, which is the whole first-pass; redline does not support that
   mode. See [ADR-0008](./adr/0008-trained-classifier-is-an-optional-overlay.adr.md)
   (amended). Any earlier "Isaacus-optional / air-gap" machinery
   (`EnrichmentMode.OFFLINE`, the air-gap pipeline test, the UI toggle) is
   **retired**, not merely vestigial — its removal is a cleanup follow-up.

---

## 6. Build state

_Update at the end of every thread. New numbering; see §3 for the old→new crosswalk._

| Thread                                      | Track | Package(s)              | Status         | Notes                                                                 |
| ------------------------------------------- | ----- | ----------------------- | -------------- | --------------------------------------------------------------------- |
| 37a — womblex pod (test harness)            | H     | womblex-ingest, infra   | 🔵 **next**    | Was part of #36. Packages the required womblex subsystem as its own pod + compose profile; lands real shards in MinIO. Retires the stub-as-default framing. [thread-37a](./threads/thread-37a-womblex-pod.md) |
| 37b — Real womblex binding                  | H     | womblex-ingest          | ⚪ not started | Was #36. Binds the real extractor/embedder behind the seam; reads 37a's shards; proves real-corpus retrieval. [thread-37b](./threads/thread-37b-real-womblex-binding.md) |
| 38 — In-app review grid                     | P     | redline-web             | 🔷 **needs verification** | Was #12. Conflicting done-state across frozen iterations; verify against exit test, then close here (record evidence or complete). |
| 39 — Pricing pivots                         | P     | application, redline-web | 🔷 **needs verification** | Was #13. As #38 — verify, then close here.                            |
| 40 — Excel export                           | P     | redline-web             | 🔷 **needs verification** | Was #14. As #38 — verify, then close here.                            |
| 41 — Next.js shell                          | H     | redline-web             | ⚪ not started | Was #35. Closes the `/e2e` deviation.                                 |
| 42 — Collision selection & capping          | L     | domain                  | ⚪ not started | Was #26. First lens thread after the engine binding.                  |
| 43 — `BoundaryDecision` entity              | L     | domain                  | ⚪ not started | Was #27. Net-new modelling (open question #4).                        |
| 44 — Decision persistence + corrections     | L     | adapters                | ⚪ not started | Was #28. Upstream ADR-0020.                                           |
| 45 — Lens persistence                       | L     | adapters                | ⚪ not started | Was #29. Depends on D3.                                               |
| 46 — Lens portability                       | L     | application             | ⚪ not started | Was #30. The compounding proof.                                       |
| 47 — Lens stage machine                     | L     | redline-web             | ⚪ not started | Was #31. Must not disturb Thread 11.                                  |
| 48 — Collision resolution surface           | L     | redline-web             | ⚪ not started | Was #32.                                                              |
| 49 — Sample accrual                         | L     | adapters                | ⚪ not started | Was #33.                                                              |
| 50 — Train/activate policy                  | L     | adapters                | ⚪ not started | Was #34. Engages the overlay.                                         |
| 51 — Workspace extraction & release         | H     | workspace               | ⚪ not started | Was #16. Grafts the Threads 6–8 overlay onto the fork; depends on #37.|
