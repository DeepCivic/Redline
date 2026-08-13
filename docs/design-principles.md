# redline — Design principles & non-goals

> **Status:** durable design rationale · companion to
> [`architecture.md`](./architecture.md) (what redline *is*).
>
> This file records the principles redline **adopted from its upstream engines**
> and the **non-goals** it holds — the rationale that is not tied to a single
> decision. It tracks nothing; outstanding work is in
> [`delivery-plan.md`](./delivery-plan.md).
>
> **This register survives, and it is the only decision record redline keeps.**
> The ADRs were deleted deliberately (`.claude/CLAUDE.md`, "Deliberate deviations
> from Wayfinder") — decisions are now made and recorded in the commit that acts
> on them, and a decision durable enough to govern many commits is written here
> instead. It did not collapse into `architecture.md` because that document says
> what redline *is*; this one says what redline *decided*, which is what a reader
> needs when they are about to contradict it.
>
> The register began as D4–D10 in the retired `dev-iteration-2.md`, which is why
> it once started at D4. **D1 and D2 are written in below** — both were cited as
> settled across the tree while being absent here, and D2 is load-bearing in six
> source files. **D3 and everything above D10 are retired**: they named ADRs that
> no longer exist, nothing in the tree cites them, and their content is not
> recoverable from it — so the numbers are left as gaps rather than reused, which
> would make an old citation resolve to the wrong decision. Numbering therefore
> runs D1, D2, D4–D10.
>
> **The docs no longer cite ADR numbers at all.** `architecture.md` carried 53 of
> them across 18 dead numbers; each has been deleted, and where the citation
> carried something the prose did not — a supersession, an amendment date — that
> substance was written into the prose instead. Numbering collided badly enough to
> be worth stating: redline's `ADR-0001` and Wayfinder's live `001` were different
> documents sharing a number. Source comments still carry `ADR-00xx`; read those
> as pointers into git history, except where the number is plainly upstream's
> (Wayfinder's, Numbatch's and womblex's own registers do still exist).

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
  is the mechanism behind D2 — the port the two paths interchange at.)

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

| # | Principle | Adopted from / settled |
|---|---|---|
| D1 | Procurement is the purpose; the comprehension lens is the means. Generalising the lens beyond procurement is a non-goal | Settled 2026-07-24 |
| D2 | The classification paths interchange at the port: a consumer cannot tell whether hard rules, adjudication or a trained overlay produced a row | Settled with the cold-start path |
| D4 | Operations are independent functions over joinable sidecars; no orchestrator | womblex composable design |
| D5 | Embedding is womblex's; redline computes no vectors and ranks none — but it **does** store them | womblex embed stage (`*.embeddings.parquet`) |
| D6 | Boundary decisions are content-addressed | womblex `source_hash` addressing |
| D7 | The base is verbatim; resolutions are additive overlays | womblex sidecar model |
| D8 | Corpus classifications are ephemeral; the lens is durable | Numbatch two-tier model |
| D9 | Boundary decisions are corrections-as-sample-membership | Numbatch's corrections register |
| D10 | Preconditions ride the type boundary; only misuse errors | womblex enforcement posture |

**On D2 — where it bites.** It is cited in `cold-start-classifier.ts`,
`classify-with-hard-rules.ts`, `adjudicate-unclear.ts`,
`classification-lens-reader.ts`, `adjudicator.ts` and `container.ts`: every path
emits the same `RequirementClassification` shape, so the review grid, the pivots
and the document map never branch on provenance. Breaking it means every
downstream consumer learns which engine ran.

**On D5 — what it used to say, and why it changed.** It read *"Retrieval is
womblex's; redline builds no vector store of its own"*, and what shipped
contradicts it: `redline_chunks` carries `embedding jsonb` + `embedding_model`
in redline's own Postgres. The part that survived is the part that mattered —
redline never *computes* an embedding (womblex's `embed` stage does, via Isaacus
`kanon-2-embedder`) and never *ranks* by one: `IChunkStore.findSimilar` is
declared and refuses, because the `pgvector`/ANN index is deferred. So redline
holds the vectors without being a vector store in the sense the principle was
guarding against. Restate it again if `findSimilar` is ever implemented — at that
point redline *is* doing retrieval, and D5 becomes a different decision rather
than a narrower one.

---

## 2. Non-goals

Recorded so they do not creep back thread by thread:

- **No synthetic data probes.** A moving target while the lens is unstable.
- **No autonomous questioning.** Replaced by bounded multiple-choice collisions.
- **No graph visualisations.** Unnecessary for the target use cases.
- **No confidence scores in the UI.** Replaced by Clear/Ambiguous buckets.
- **No lens orchestrator.** Explicitly rejected — womblex deleted theirs.
- **Engine config is authored through a defined allow-list, and the list is
  wider on a first run than on a re-run.** The Create Corpus surface *may* author
  a per-run override over `infra/womblex/redline.yaml`, which is the default
  layer: a field left blank inherits the default we defined. The overridable set
  is a **defined allow-list**, not the whole config, but it is not one list. The
  safety argument behind the narrow version — that changing a structural key
  silently orphans the vectors, deletes table cells, or empties the graph the
  report assembler navigates — needs *prior outputs to orphan*, so it is a
  **re-run** argument and does not bind a corpus's first run.
  **Always authorable:** the **stage sequence** (which of chunk/embed/enrich/
  money run, in what order), the **chunk mode** (`chunking.chunking_model` null
  for offline token chunking vs set for AI/semantic chunking, plus `chunk_size` /
  `chunk_tables`), and the **money vocabulary**
  (`money.columns.extra_header_terms` / `money.columns.extra_veto_terms` and
  `money.default_currency`, corpus-specific by nature).
  **Authorable on a first run only:** **extraction and OCR settings**, including
  `extraction.ocr.engine`. A first run is where they matter — `redline.yaml`
  marks `paddleocr` LOAD-BEARING because a VLM engine returns markdown with no
  regions and so deletes every table cell on a scanned page, and a scanned tender
  is made of those — and it is the run with nothing yet to orphan. Refused over a
  corpus that already has shards.
  **Never authorable:** the embed **model** and `task`, because the chunk vectors
  must pair with the sidecar's query embeddings and that is not a per-corpus
  choice, and the Isaacus gate.
  The mechanism is the override layer; the safety is the split between those
  three lists. This supersedes the earlier flat "no engine tuning in UI" and the
  single-list version that followed it — some tuning *is* a run-shape choice a
  user makes, and a first run is entitled to more of it than a re-run.
- **A corpus is a womblex run, and the user names it.** womblex mints run ids
  itself when none is given (`generate_run_id()` → `run-YYYYMMDDTHHMMSSZ`) and
  accepts a caller-supplied one otherwise. They are engine identities that work
  inside the engine and are optionally named. redline **consumes what it gets**:
  it does not mint them, does not validate their shape, and does not curate them.
  The name a specialist types on Create Corpus is the run, the object-store
  prefix and later the evaluation id, because they are one identity. Rules that
  treated the corpus id as an invariant redline had to protect — "pick, never
  type" — are withdrawn: they produced a surface that could only re-run a corpus
  something else had already extracted.
- **Air-gap / offline operation.** Both the `chunk` and `embed` stages require
  Isaacus; a deployment that cannot reach it cannot build a corpus to read.
  (See `architecture.md` §2 and §7.1.)

Re-entry condition for the first five: revisit after a lens has accumulated 20+
boundary decisions in real use.
