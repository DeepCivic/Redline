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
> it once started at D4. **D3 and everything above D10 are retired**: they named
> ADRs that no longer exist, nothing in the tree cites them, and their content is
> not recoverable from it. **D1, D2, D6, D8 and D9 were retired with the
> comprehension lens** when redline became a corpus-ingest-and-report substrate:
> each was about the lens, boundary decisions or the classification port, and
> none of those exist. Retired numbers are left as gaps rather than reused, which
> would make an old citation resolve to the wrong decision. Numbering therefore
> runs D4, D5, D7, D10.
>
> **The docs no longer cite ADR numbers at all.** `architecture.md` carried 53 of
> them across 18 dead numbers; each has been deleted, and where the citation
> carried something the prose did not — a supersession, an amendment date — that
> substance was written into the prose instead. Numbering collided badly enough to
> be worth stating: redline's `ADR-0001` and Wayfinder's live `001` were different
> documents sharing a number. Source comments still carry `ADR-00xx`; read those
> as pointers into git history, except where the number is plainly upstream's
> (Wayfinder's and womblex's own registers do still exist).

---

## 1. Composable operations, not a pipeline

redline adopts womblex's composable design deliberately and in detail. The
lessons and how each lands here:

- **Stages communicate through persisted, joinable sidecars — never an
  orchestrator.** womblex *had* a stage registry and deleted it: operations are
  independent functions that callers compose directly. → redline's reads are
  independent functions over shards joinable on `source_hash` (+ `chunk_index`).
  redline drives and observes the engine's run; it does not wrap it.

- **The base is verbatim and never rewritten.** The extraction shard is verbatim;
  every downstream mutation is a separate sibling parquet. → redline stores what a
  run landed as the run wrote it, and never edits it in place. What a consumer
  makes of those rows is the consumer's, above the store.

- **Enforcement is pragmatic.** A disabled stage passes through unchanged; a
  per-document gap is skipped; only genuine misuse raises; structural
  impossibilities fail at the type boundary. → A skipped document is **not** a
  `DomainError`; preconditions ride the type boundary, and only misuse errors.

### The adopted principles, as a register

| # | Principle | Adopted from / settled |
|---|---|---|
| D4 | Operations are independent functions over joinable sidecars; no orchestrator | womblex composable design |
| D5 | Embedding is womblex's; redline computes no vectors and ranks none — but it **does** store them | womblex embed stage (`*.embeddings.parquet`) |
| D7 | The base is verbatim; redline stores what a run landed and never rewrites it | womblex sidecar model |
| D10 | Preconditions ride the type boundary; only misuse errors | womblex enforcement posture |

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

- **No comprehension lens.** The lens, its topics, its hard rules, the
  adjudication seam and the boundary decisions built on them were removed when
  redline became a corpus-ingest-and-report substrate. redline stages a corpus,
  runs the engine over it and serves the rows; interpreting them belongs to a
  consumer, above the store. Re-entering that ground is a new design, not a
  restoration — the deleted code is in git history, but the framing it rested on
  (D1, D2, D6, D8, D9) is retired.
- **No graph visualisations.** Unnecessary for the target use cases.
- **No orchestrator.** Explicitly rejected — womblex deleted theirs.
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
  prefix and the key its rows are stored under, because they are one identity.
  Rules that treated the corpus id as an invariant redline had to protect —
  "pick, never type" — are withdrawn: they produced a surface that could only
  re-run a corpus something else had already extracted.
- **Air-gap / offline operation.** Both the `chunk` and `embed` stages require
  Isaacus; a deployment that cannot reach it cannot build a corpus to read.
  (See `architecture.md` §2 and §7.1.)

The lens non-goal has no re-entry condition on the calendar: it is revisited if
and when a consumer of the substrate's rows needs one, and it re-enters as a new
design above the store rather than as the aggregate that was removed.
