# redline — Design principles & non-goals

> **Status:** durable design rationale · companion to
> [`architecture.md`](./architecture.md) (what redline *is*) and
> adr/ (the decisions).
>
> This file records the principles redline **adopted from its upstream engines**
> and the **non-goals** it holds — the rationale that is not tied to a single
> decision and so does not live in one ADR. It tracks nothing; outstanding work
> is in [`delivery-plan.md`](./delivery-plan.md).
>
> These were originally the D4–D10 register and §8 non-goals of the retired
> `dev-iteration-2.md` (the comprehension-lens design). The D1–D3, D11–D13
> decisions from that document became ADRs
> (0007–0009,
> 0010,
> 0011,
> 0014);
> the principles below did not, because they are adopted-and-recorded rather than
> debated, and each governs many threads rather than one.

---

## 1. Composable operations, not a pipeline

redline adopts womblex's composable design deliberately and in detail. The
lessons and how each lands here:

- **Stages communicate through persisted, joinable sidecars — never an
  orchestrator.** womblex *had* a stage registry and deleted it: operations are
  independent functions that callers compose directly. → redline's classification
  and lens operations are independent functions over shards joinable on
  `source_hash` (+ `chunk_index`). There is **no lens orchestrator** (and none is
  wanted — see the non-goals). Strategy-selection registries (e.g. Numbatch's
  roll-up strategy, model family) are a different, legitimate pattern and are not
  what "no orchestrator" prohibits.

- **The base is verbatim and never rewritten.** The extraction shard is verbatim;
  every downstream mutation is a separate sibling parquet. → Classifications and
  resolutions are **additive sibling overlays**. A boundary decision never mutates
  the extraction record.

- **A missing overlay falls back — ordering, not dependency.** In womblex, `chunk`
  reuses `enrich`'s sidecar when present and self-enriches when absent. → The
  trained Numbatch adapter is an **optional overlay**, not a required stage; the
  cold-start path (hard rules → retrieval → adjudication) runs without it. (This
  is the mechanism behind ADR-0008.)

- **Content-addressed identity makes reuse a cache hit by construction.**
  `source_hash = sha256(record_id + text)` — re-ingesting an unchanged record
  yields the same hash, and its existing sidecars still join. → Boundary decisions
  are keyed on content hash, so a decision re-attaches automatically when the same
  document appears in a different corpus. **This is the mechanism by which the lens
  compounds**, rather than a promise that it does.

- **Enforcement is pragmatic.** A disabled stage passes through unchanged; a
  per-document gap is skipped; only genuine misuse raises; structural
  impossibilities fail at the type boundary. → A skipped document is **not** a
  `DomainError`; preconditions ride the type boundary, and only misuse errors.

- **Signals are a named, statused register.** womblex's
  `heuristics_disambiguation.md` lists each heuristic with its implementing symbol
  and implemented/not-implemented status. → The ambiguity signals driving the
  Clear/Ambiguous derivation get the same treatment, rather than an opaque
  threshold.

Hard rules bypassing the model has direct upstream precedent: womblex's register
ingests (G-NAF, ABN, geospatial) produce Parquet directly and bypass the NLP
pipeline by design.

### The adopted principles, as a register

| # | Principle | Adopted from |
|---|---|---|
| D4 | Operations are independent functions over joinable sidecars; no orchestrator | womblex composable design |
| D5 | Retrieval is womblex's; redline builds no vector store of its own | womblex embed stage (`*.embeddings.parquet`) |
| D6 | Boundary decisions are content-addressed | womblex `source_hash` addressing |
| D7 | The base is verbatim; resolutions are additive overlays | womblex sidecar model |
| D8 | Corpus classifications are ephemeral; the lens is durable | Numbatch two-tier model |
| D9 | Boundary decisions are corrections-as-sample-membership | Numbatch ADR-0020 |
| D10 | Preconditions ride the type boundary; only misuse errors | womblex enforcement posture |

---

## 2. Non-goals

Recorded so they do not creep back thread by thread:

- **No synthetic data probes.** A moving target while the lens is unstable.
- **No autonomous questioning.** Replaced by bounded multiple-choice collisions.
- **No graph visualisations.** Unnecessary for the target use cases.
- **No confidence scores in the UI.** Replaced by Clear/Ambiguous buckets.
- **No lens orchestrator.** Explicitly rejected — womblex deleted theirs.
- **Air-gap / offline operation.** Retrieval requires Isaacus; a deployment that
  cannot reach it cannot retrieve. (See ADR-0008,
  amended, and `architecture.md` §2.)

Re-entry condition for the first five: revisit after a lens has accumulated 20+
boundary decisions in real use.
