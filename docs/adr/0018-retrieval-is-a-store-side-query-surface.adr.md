# ADR-0018 — The retrieval leg is a store-side query surface addressed by provenance; similarity is one tool, not the seam

- **Status**: Proposed
- **Date**: 2026-07-30
- **Depends on**: [ADR-0017](./0017-bulk-womblex-data-stays-parquet-json-is-for-presentation.adr.md)
  (bulk data is Parquet in redline's store, not JSON to TypeScript). This ADR
  specifies the query surface ADR-0017 leaves open.
- **Amends**:
  - [ADR-0014](./0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) —
    replaces its domain port `IEmbeddingReader` (a reader returning `Float32Array`
    vectors) with a store-side query surface. ADR-0014's model-match refusal and
    `(source_hash, chunk_index)` join survive as invariants of the store.
  - [ADR-0008](./0008-trained-classifier-is-an-optional-overlay.adr.md) — its
    cold-start path *"hard rules → retrieval → adjudication"* is preserved; only the
    mechanism of the retrieval leg changes (store query, not in-TS cosine over shipped
    vectors). Both classification paths still satisfy one port; consumers still cannot
    tell which ran.

## Context

ADR-0017 establishes that womblex's bulk output (embeddings first) lives as Parquet in
redline's own store (MinIO and/or the `redline_` Postgres schema, ADR-0002) and is
queried in place, because (a) the ~90k-chunk corpus is past ADR-0014's 50k JSON
re-entry trigger, and (b) the consumer is a **deterministic report assembler** — an
LLM copying byte-identical chunks / cells / spans into a template's slots, addressing
them by provenance keys, using vector similarity only to *discover* candidates.

ADR-0017 deliberately does not say **what backs the store** or **what the query
surface looks like**. Those are this ADR's:

1. a domain **port** that expresses "address these rows / find candidates" without a
   vector ever entering TypeScript;
2. a **store** that holds the columnar data and answers those queries at 90k-vector
   scale (ANN + exact lookup);
3. a **tool/graph surface** the report-building LLM calls.

Two failure modes to avoid. Over-fitting to *similarity* rebuilds the chatbot shape
ADR-0017 rejected. Over-fitting to *exact lookup* forgets that the cold-start
classifier (ADR-0008) genuinely needs nearest-neighbour to *place* an unlabelled
chunk against a requirement definition. The surface must do both: **exact addressing
(the transfer mechanic) and similarity discovery (one predicate).**

## Decision

**Retrieval becomes a store-side query surface. The domain gains a port whose
operations are (a) exact fetch by provenance key and (b) similarity discovery
returning provenance-keyed candidates — never raw vectors. The store is Postgres with
`pgvector` in redline's `redline_` schema; womblex's embedding Parquet is loaded into
it at ingest. The LLM report builder reaches the same surface through tools.**

### The port (domain)

Replace `IEmbeddingReader` with a retrieval/lookup port whose results are addressable
rows, not vectors. Illustrative shape (final names in the build thread):

```
IChunkStore {
  // Exact, deterministic — the transfer mechanic. Returns byte-identical text +
  // provenance for a stable key, so an LLM copies it verbatim into a report slot.
  fetchChunks(evaluationId, chunkIds: ChunkId[])            -> Result<ChunkRow[]>
  fetchByStructure(evaluationId, filter: StructureFilter)   -> Result<ChunkRow[]>
        // filter over document / content_type / heading / table (row,col) / page

  // Discovery — one predicate. Similarity runs in the store; only keyed candidates
  // cross the seam, never the 1792-d vectors. The query text is embedded store-side
  // by the same model the chunks declare, or the match is refused (ADR-0014).
  findSimilar(evaluationId, queryText, k, filter?)          -> Result<ScoredChunkRef[]>
}
```

- `ChunkRow` carries the **verbatim** `text` and full provenance (`documentId`,
  `chunkId`, `chunkIndex`, `contentType`, char offsets, page). `ScoredChunkRef` is a
  key + score only — the LLM then `fetchChunks` the ones it will copy, so the transfer
  is always an exact, deterministic read.
- **No `Float32Array`, no `number[]` vector, ever crosses into TypeScript.**
  `redline-domain` purity (validate.sh #4) keeps the port dependency-free by
  construction.

### The store

- **Postgres + `pgvector`, in redline's `redline_` schema (ADR-0002).** redline
  already runs Postgres and owns this schema; a vector column + an ANN index (HNSW)
  answers `findSimilar`, and ordinary indexed columns (`source_hash`, `chunk_index`,
  `content_type`, `parent_elem_order`, `row`, `col`) answer the exact/structural
  fetches. One store does both halves, transactionally, with redline's own migrations.
- **Load path:** on ingest, the sidecar (the one component that reads womblex Parquet,
  ADR-0003/0017) streams `*.chunks.parquet` + `*.embeddings.parquet` into the
  `redline_` tables. The Parquet objects also remain in MinIO as the durable record
  (ADR-0002), so the DB is a queryable projection, re-buildable from the shards.

### The tool/graph surface

- The LLM report builder calls the same operations as **tools** (`fetch_chunks`,
  `fetch_by_structure`, `find_similar`) — the graph it traverses is womblex's
  entity/edge data (`enrich` sidecars) exposed as further read tools, addressing the
  same rows. Tools are thin wrappers over the port/store; they add no new data path.
- This keeps the report mechanic deterministic: tools return addressable, verbatim
  rows; the LLM decides which to copy, not what they say.

## Consequences

**Positive**

- One store answers both the deterministic transfer (exact fetch) and the discovery
  (similarity) the cold-start classifier needs, at 90k-vector scale, without vectors
  crossing to TypeScript.
- Reusing Postgres/`pgvector` avoids standing up a separate vector service; migrations,
  backup and tenancy ride redline's existing DB (ADR-0002).
- The domain port stays plain data; ADR-0008's cold-start pipeline shape is unchanged
  behind it; ADR-0017's "no bulk in TS" holds by construction.

**Negative**

- **`pgvector` HNSW at ~90k vectors × 1792-d** is a real index to size and tune (build
  memory, `ef_search`, recall/latency). Manageable at this scale, but it is capacity
  work, and 1792-d rows are large. If it proves inadequate the fallback is an ANN
  index over the Parquet (FAISS/hnswlib) behind the same port — the port is chosen so
  that swap costs no domain change. *(This is the "another ADR may be required" hook:
  if the store backing changes, it is a follow-on ADR amending only this one.)*
- **Ingest now includes a load step** (Parquet → `redline_` tables), new operational
  surface and a place for the DB to drift from the shards; the shards remaining the
  record (rebuildable projection) is the mitigation.
- **Embedding a query store-side** requires the sidecar's query-embed path (already
  built for ADR-0014's query endpoint) to sit behind `findSimilar`; the model-match
  refusal moves into the store query.

## Alternatives considered

- **ANN index over the Parquet shards (FAISS / hnswlib), no DB.** Viable and possibly
  faster for pure similarity, but it answers only the discovery half; the exact /
  structural fetches (the *transfer* mechanic) then need a second query path over the
  Parquet, and there is no transactional join to redline's own entities. Kept as the
  documented fallback if `pgvector` capacity disappoints, behind the same port.
- **A dedicated vector database (Qdrant / Weaviate / Milvus).** Rejected for now:
  another service to run, secure and back up, duplicating what `pgvector` gives inside
  a DB redline already owns (ADR-0002). Revisit only if scale outgrows `pgvector`.
- **Keep vectors in TypeScript, just cache harder.** Rejected in ADR-0017 — 90k × 1792
  as JSON is ~2.5–3 GB; caching does not change that it must not enter the app tier.
- **Similarity-only surface (ship top-k, LLM works from neighbours).** Rejected in
  ADR-0017 as the chatbot shape; retained here only as `findSimilar`, one predicate
  feeding an exact `fetchChunks`.

## Enforcement

- `redline-domain` gains the retrieval/lookup port and **no vector DTO**; validate.sh
  #4 (domain purity) keeps it Parquet/Arrow/vector-free.
- The `redline_` schema migrations add the chunk/embedding tables + the `pgvector`
  index; the sidecar's ingest gains the Parquet→DB load, and stays the only reader of
  womblex's schema (ADR-0003/0017).
- The exit test runs against a **real** fixture store loaded from a captured womblex
  run (small, real vectors), asserting: exact `fetchChunks` returns byte-identical
  text for a stable key; `findSimilar` ranks an on-topic chunk first; a query embedded
  under a mismatched model is refused (ADR-0014's invariant).
- `ClassifyByRetrieval` (ADR-0008 cold start) is rebuilt on the new port; its output
  `RequirementClassification` shape is unchanged, so `BuildEvaluationTable` and the
  presentation seam are untouched.

---

## Addendum — similarity (RAG) is deferred; the exact-fetch half ships alone first

- **Status**: Proposed
- **Date**: 2026-07-31

### Context

The decision above specifies the *whole* surface at once: exact fetch **and**
similarity discovery, an ANN index (`pgvector` HNSW) under `findSimilar`, and a
tool/graph RAG surface for the report builder. Read against what the next two
releases actually need, that is more than the moment calls for — and the expensive,
fiddly part (an ANN index to size and tune, a query-embed path, a tool/graph loop)
sits entirely in the *similarity* half. **RAG is not needed for this release, or the
one after it.** Building it now buys nothing shippable and risks an index/vector layer
that has to be maintained and reasoned about before anything depends on it.

The consumer that *does* ship (ADR-0017's deterministic report assembler) works from
**exact, provenance-addressed fetch** — `fetchChunks` / `fetchByStructure` returning
byte-identical rows by stable key. That half needs no vector index at all: ordinary
indexed columns answer it.

### Decision

**Split the surface. Build the exact-fetch half now; defer the similarity half —
`findSimilar`, the `pgvector`/ANN index, the query-embed path, and the tool/graph RAG
surface — until a release actually requires it.**

- **Ships now:** the port's `fetchChunks` / `fetchByStructure`; the `redline_` chunk
  and provenance tables with their ordinary indexes; the Parquet→DB load. No vector
  column, no HNSW index, no query embedding. The embedding Parquet still lands in
  MinIO as the durable record (ADR-0002) — it is *stored*, just not *indexed* yet, so
  turning similarity on later is a load/index step, not a re-ingest.
- **Deferred (its own build thread, when a release needs it):** `findSimilar`, the
  `pgvector` HNSW index (and the FAISS/hnswlib fallback debate), the store-side
  query-embed path, and the tool/graph surface. The port is *declared* with
  `findSimilar` in its shape so adding it later is additive, but it may ship
  **unimplemented** (returning a `NOT_IMPLEMENTED` `DomainError`) until then.
- **Consequence for ADR-0008 (must be stated plainly):** ADR-0008's cold-start path is
  *"hard rules → retrieval (nearest-neighbour) → LLM adjudication."* With similarity
  deferred, **the retrieval leg of that path is deferred with it.** For these
  releases, cold-start classification rests on hard rules + LLM adjudication over
  exact/structural fetches; the trained Numbatch overlay engages as before once its
  sample floor is crossed. This does not weaken ADR-0008 — both paths still satisfy
  one port — but it narrows what the *untrained* first pass can do until RAG lands,
  and that trade is accepted on the ground that RAG is not a this-release capability.

### Consequences

- **Less to build and nothing premature to tune.** No ANN index to size, no
  recall/latency budget, no query-embed path, no tool loop — none of it enters the
  system before something depends on it. The "pain in the ass" that a half-used
  vector/RAG layer becomes is simply not created yet.
- **The forward door stays open cheaply.** Vectors are already in MinIO; the port
  already names `findSimilar`; the store backing (`pgvector` vs ANN-over-Parquet) is
  still an open follow-on ADR — but now it is decided *when RAG is built*, on real
  need, not speculatively. Turning similarity on is an index build + one adapter
  method, not a seam change.
- **The first-pass classifier is weaker in the interim.** Until RAG lands, an
  untrained lens leans on hard rules + adjudication without nearest-neighbour placing.
  Accepted deliberately; revisit when a release makes RAG a requirement.
- The `findSimilar`/`pgvector` material in **Decision → The store**, **The tool/graph
  surface**, the `pgvector` capacity note under **Negative**, and the similarity
  clauses of the **Enforcement** exit test are all **deferred by this addendum** —
  they describe the eventual shape, not this release's build. The exit test that ships
  asserts exact `fetchChunks`/`fetchByStructure` return byte-identical rows for stable
  keys; the `findSimilar` ranking and mismatched-model-refusal assertions move to the
  deferred similarity thread.
