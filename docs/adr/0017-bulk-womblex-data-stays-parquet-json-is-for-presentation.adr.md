# ADR-0017 — Bulk womblex data is consumed as Parquet (materialised to MinIO/Postgres); JSON is the presentation seam only

- **Date**: 2026-07-30
- **Amends**:
  - [ADR-0003](./0003-parquet-to-json-boundary.adr.md) — narrows the JSON boundary
    to the *presentation* read model. The extraction *provenance* (elements, chunks,
    table cells) a specialist reads on screen still crosses as JSON, exactly as 0003
    decided; what changes is that **bulk data no longer does**. ADR-0003's invariant
    — the sidecar owns the Parquet stack, the TypeScript workspace links no Parquet
    reader — is *kept and strengthened*: bulk data never reaches TypeScript at all.
  - [ADR-0014](./0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) —
    **overturns its core decision** that embeddings cross as JSON float arrays parsed
    into `Float32Array` in TypeScript. ADR-0014 wrote its own re-entry condition
    ("*Revisit when a real corpus has been measured … if a corpus exceeds ~50k
    chunks … the alternative becomes the better choice*"); this ADR is that revisit.
    ADR-0014's data guarantees that remain true of the *store* — vectors declare their
    `model`, join on `(source_hash, chunk_index)`, and a query vector must match the
    chunk vectors' model or the match is refused — are carried forward, not discarded.

## Context

ADR-0003 and ADR-0014 fixed the womblex→redline seam as **JSON**: the sidecar reads
its Parquet shards and serves document-scoped JSON, so the TypeScript workspace links
no Parquet/Arrow reader. ADR-0014 shipped embeddings the same way — a document's
vectors as a JSON `number[]`, parsed into a `Float32Array` in `redline-adapters`, with
nearest-neighbour retrieval running in `redline-application` in TypeScript. It sized
the payload for procurement corpora deliberately and set a **re-entry condition at
~50k chunks**, or when the sidecar and app run in different regions.

**Two things have since become concrete, and both point the same way.**

1. **The corpus has been measured, and it crosses ADR-0014's own line.** A real
   womblex 0.3.0 run (`kanon-2-embedder`, 1792-dim vectors) over representative
   tender documents gave ~30 chunks for a 25-page document. The target corpus is
   **~1,500 documents at ~0.9–1.5 MB each**, i.e. of order **~90,000 chunks**. At
   1792 dims:
   - **~645 MB** of packed `float32` vectors, and
   - **~2.5–3 GB** as JSON floats (the ~4–5× text-vs-packed penalty ADR-0014 itself
     names), re-parsed into `Float32Array` under a container memory limit, per
     evaluation, re-paid on every tuning pass without a cache.

   ADR-0014's re-entry trigger was 50k chunks. At ~90k this is no longer a judgement
   call — the decision reached the boundary it drew for itself. Shipping vectors to
   TypeScript as JSON is not viable at this size; redline holds this data as
   **Parquet, MinIO, or Postgres regardless.**

2. **The consumer is a deterministic report assembler, not a retrieval ranker.**
   redline's target is an **LLM that fills a report template by conceptually
   copy/pasting chunks, sub-chunks, table cells and money spans — verbatim, with their
   provenance — into the template's slots**, traversing a graph and calling tools to
   locate the right source rows. This is **deterministic verbatim assembly**, not
   fuzzy retrieval-and-paraphrase:
   - The transfer into a report slot is a **lookup by stable key** — `source_hash`
     (`documentId`), `elem_order`, `chunk_index` (`chunkId`), `row`/`col`, char
     offsets — returning the **byte-identical** source text womblex extracted. The
     same query returns the same rows every time.
   - **Vector similarity is at most a *discovery* aid** — one predicate for *finding*
     candidate rows — never the mechanism of transfer. An LLM copying a pricing cell
     into a "Capability 4 — Implementation Labour" slot addresses that cell by
     `(document, table, row, col)`; it does not paraphrase the nearest vector.

   So the seam owes **queryable, addressable, structured data with intact
   provenance** — which is what columnar Parquet (optionally loaded into Postgres) is,
   and what womblex already writes. Neither "ship all the vectors as JSON" (too big)
   nor "ship top-k neighbours as JSON" (the chatbot shape — it returns *similar*
   rows, not *addressable* ones, and discards the structured access verbatim assembly
   needs) is the target.

   > This "graph" is a **data/knowledge graph the LLM traverses as a tool** (of the
   > kind womblex's `enrich` stage produces — entities, `graph_edges`,
   > `entity_links`), **not** a UI graph visualisation. `design-principles.md` rules
   > out graph *visualisations* as a non-goal; nothing here reopens that. It is also
   > **not a chatbot**: there is no conversational retrieval loop, only deterministic
   > extraction into a template.

An independent third finding from the same run, recorded so it is not re-derived:
womblex assigns `chunk_index` as a **single monotonic per-document sequence spanning
narrative *then* table chunks** (`process/chunker.py` re-sequences the concatenated
list: `chunk_index = len(repaired)`). A real REOI produced narrative chunks 0–21 then
table chunks 22–29; **`(source_hash, chunk_index)` is already unique across content
types.** The `content_type` "join-key collision" that `delivery-plan.md §4.1` and
ADR-0014's Consequences worried about **does not occur in real womblex output.** That
retires the collision concern independently of this ADR; `content_type` survives only
as provenance carried alongside a row, and this ADR governs how that row is stored and
queried.

## Decision

**redline consumes womblex's bulk output as Parquet and materialises it into its own
store (MinIO objects and/or the `redline_` Postgres schema — ADR-0002). Bulk data —
first the embeddings, and any other columnar dataset whose per-evaluation volume
scales with the corpus — is never forced through the JSON seam. Source rows are
addressed by their womblex provenance keys and returned byte-identical, so an LLM can
copy them verbatim into a report template. JSON remains the seam for the
*presentation* read model the TypeScript UI renders and exports.**

The seam is split by **data role**, not by producer:

| Data | Per-evaluation volume | Seam | Consumer |
|---|---|---|---|
| **Embeddings** (discovery substrate) | ~90k vectors, ~GBs | **Parquet, materialised to the store; queried in place.** Never crosses to TS as bulk. | store-side query tool (ADR-0018) |
| **Money spans / columns**, and any future corpus-scaled columnar sidecar | grows with corpus | **Parquet → store**, addressed by provenance | report tools |
| **Extraction provenance** (elements / chunks / table cells) | 20–235 KB/doc | **JSON** (ADR-0003, unchanged) — small, typed, addressable, byte-identical | review flow; report tools |
| **Review grid / pivots / Excel export** (presentation) | small, derived | **JSON** (unchanged) | `redline-web` |

Three things this pins:

- **"Use" means materialise and address, not re-serialise.** redline reading
  womblex's Parquet does not mean re-emitting it as another bulk format. It means the
  Parquet lands in redline's own store — objects in its MinIO bucket, and/or loaded
  into its Postgres schema — under redline's control (ADR-0002), and is **queried and
  addressed where it lives**, returning verbatim rows keyed by womblex provenance. The
  sidecar remains the one component that understands womblex's Parquet schema
  (ADR-0003's invariant); the schema knowledge does not leak.

- **The TypeScript workspace still links no Parquet/Arrow reader.** ADR-0003's guard,
  now *stronger*: bulk data does not reach TypeScript in any form, so there is nothing
  to parse there. The domain's retrieval port stops being "a reader that returns
  vectors" (ADR-0014's `IEmbeddingReader`); the exact query surface that replaces it —
  addressing rows by provenance, similarity as one predicate — is **ADR-0018**.

- **JSON is retained deliberately for presentation.** Everything a human reads on
  screen or exports to Excel stays JSON: small, self-describing, diff-able, no columnar
  engine in the browser tier. ADR-0014's "debuggable and fixture-able offline" virtue
  is exactly why JSON stays for the presentation seam.

## Consequences

**Positive**

- The bulk substrate is held at its natural size and format — no ~2.5–3 GB JSON
  inflation, no `Float32Array` reparse under a memory limit, no per-tuning-pass
  re-transfer. The corpus that broke ADR-0014's sizing is handled at source.
- The report-building LLM gets **addressable, byte-identical, provenance-tagged**
  source rows to copy into template slots — the actual product mechanic — rather than
  a ranked neighbour list it would have to re-query around.
- ADR-0003's schema-locality and "no Parquet in TS" invariants are preserved and
  tightened; the change *narrows* the JSON seam rather than adding new coupling.
- The presentation path is untouched: `redline-web`, the review grid, pivots and
  Excel export need no change from this ADR.

**Negative**

- **The retrieval leg is re-architected.** ADR-0014's `IEmbeddingReader` +
  `ClassifyByRetrieval` (cosine math in TypeScript over shipped vectors) no longer
  fits; discovery/lookup moves to a store-side query surface. That surface — the port,
  the sidecar/tool endpoint, and what backs the store — is **ADR-0018** and is real
  work, not a config change. This ADR sizes and justifies the move; ADR-0018
  specifies it.
- **ADR-0014's testability win is lost as stated.** Its headline argument for JSON
  vectors was a pure-function exit gate over a fixture corpus with no service.
  Store-side querying makes that an integration test (or a fake query surface).
  ADR-0018 must re-establish a test posture honest at 90k chunks — a small **real**
  fixture store, not a hand-picked vector pair.
- **A store now sits between the shards and the tools.** Loading Parquet into Postgres
  (or indexing it in place) is operational surface redline did not have. Whether that
  is pgvector, an ANN index over the shards, or straight object reads is the ADR-0018
  decision; this ADR commits only to *not JSON for bulk*.
- **Two materialisations persist** (womblex's Parquet + redline's store copy), as
  ADR-0003 already accepted for JSON — but the second copy is now columnar/DB, not a
  JSON twin.

## Alternatives considered

- **Keep ADR-0014 (JSON vectors to TS), compress or paginate.** Rejected: HTTP
  compression on float text does not close a 4–5× gap that is ~2.5–3 GB before
  compression; pagination re-pays transfer per tuning pass and still parses into
  `Float32Array` under the memory limit. It defers the wall, it does not remove it,
  and the corpus is already past ADR-0014's own trigger.

- **Ship top-k ranked neighbours as JSON** (ADR-0014's own "server-side retrieval"
  alternative). Rejected *as the seam* — not on scale (it scales fine) but on **fit**.
  It is the chatbot shape: it answers "what are the nearest chunks to this query
  vector". Deterministic verbatim assembly needs to *address* rows by structure
  (document, capability, heading, table cell, money column, char span) and get them
  back byte-identical, of which vector similarity is one discovery predicate. A
  neighbours query may exist as *one tool* under ADR-0018; it is not the seam.

- **A Parquet-reading TypeScript adapter** ("TS reads the Parquet directly").
  Rejected: it drags a native Arrow binding into the pnpm workspace — the precise
  dependency ADR-0003 spent its decision avoiding — *and* still moves GBs into the
  memory-limited app tier. "redline uses the Parquet" is satisfied by materialising
  and querying it in the store, with the sidecar/tools as the reader, not by parsing
  it in the browser tier.

## Enforcement

- The domain retains **no bulk-vector DTO**. ADR-0014's `ChunkEmbedding`
  (`Float32Array`) / `DocumentEmbeddings` are removed as a *reader* shape once ADR-0018
  lands its replacement port; `redline-domain` purity (validate.sh check #4) already
  forbids a Parquet/Arrow dependency, keeping bulk data out of TypeScript by
  construction.
- The sidecar (or its successor query service) stays the **only** component importing
  `pyarrow` / womblex schema, per ADR-0003 — this ADR does not relax that.
- Retrieval-path fixtures are **real captures from a womblex run** at a size honest for
  the store (ADR-0018 pins the form), not a hand-built vector pair.
- The presentation seam's JSON contracts (extraction, review grid, pivots, export) are
  unchanged and their existing contract tests continue to pin them.
