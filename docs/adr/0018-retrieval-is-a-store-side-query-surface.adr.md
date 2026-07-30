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

## Addendum — only vector *similarity search* (ANN / `findSimilar`) is deferred; the graph and the embeddings ship

- **Status**: Proposed
- **Date**: 2026-07-31
- **Corrects**: an earlier draft of this addendum that deferred *"the tool/graph
  surface"* and left the embeddings merely *"stored, not loaded."* That over-cut:
  it conflated three separable things — the enricher's **graph**, the **embeddings as
  available data**, and **vector similarity search** — and only the last of those is
  deferrable. This addendum draws the line correctly.

### Context

The decision above specifies the whole surface at once. It is worth deferring the
part that is expensive and not yet needed — but the first cut of this addendum drew
the line in the wrong place. Three things it treated as one:

1. **The enricher's graph** — womblex's `enrich` output (`entities`, `graph_edges`,
   `entity_links`). ADR-0017 names this as *how the report-assembler LLM navigates*:
   *"traversing a graph and calling tools to locate the right source rows."* It is
   **not RAG** — no vectors, no nearest-neighbour — it is structured provenance the
   LLM walks to reach the verbatim rows it copies. The report assembler needs it to
   do its job efficiently; deferring it removes the near-term navigation mechanic.
   (`design-principles.md` rules out graph *visualisations*; the *data* graph as a
   traversal tool is explicitly in scope — ADR-0017.)
2. **The embeddings as available data** — the Isaacus vectors womblex produces
   (`*.embeddings.parquet`) are the substrate the enrich/graph stage is built from and
   the material later similarity search will index. They must be **present and
   addressable in the store**, not left as inert objects in a bucket. "Available" is a
   near-term requirement even though "ANN-indexed" is not.
3. **Vector similarity search** — the ANN index (`pgvector` HNSW), `findSimilar`, and
   the store-side query-embed path. *This* is the RAG mechanic. It is the expensive,
   fiddly part (an index to size and tune, a query-embed path, recall/latency
   budgets), and it is genuinely **not needed for this release or the next**. Building
   it now risks a half-used vector layer maintained before anything depends on it.

Only (3) is deferrable. (1) and (2) ship.

### Decision

**Defer only vector *similarity search* — the ANN/`pgvector` index, `findSimilar`, and
the query-embed path. Ship the graph, the exact-fetch surface, and the embeddings as
available store data now.**

- **Ships now — exact fetch:** the port's `fetchChunks` / `fetchByStructure`; the
  `redline_` chunk + provenance tables with ordinary indexes; the Parquet→DB load.
- **Ships now — the graph:** womblex's `enrich` output (`entities`, `graph_edges`,
  `entity_links`) is loaded into the store and exposed as read tools the LLM
  traverses, addressing the same provenance-keyed rows. This is the report
  assembler's navigation mechanic (ADR-0017), and it is not vector search.
- **Ships now — embeddings available:** `*.embeddings.parquet` is loaded into the
  store as addressable data (keyed on `(source_hash, chunk_index)`, declaring its
  `model`/`dimensions` — ADR-0014's surviving invariants), so the graph stage and any
  consumer can reach a chunk's vector. Loaded and available; simply **not yet under an
  ANN index**.
- **Deferred — similarity search only:** `findSimilar`, the `pgvector` HNSW index (and
  the FAISS/hnswlib fallback debate), and the store-side query-embed path. The port is
  *declared* with `findSimilar` so adding it later is additive; it may ship
  **unimplemented** (`NOT_IMPLEMENTED` `DomainError`) until a release needs RAG.
  Because the vectors are already loaded and available, enabling it is *building an
  index over data already in the store* — not a load or a re-ingest.
- **Consequence for ADR-0008 (stated plainly):** ADR-0008's cold-start path is *"hard
  rules → retrieval (nearest-neighbour) → LLM adjudication."* Only the
  **nearest-neighbour** step needs vector similarity, so **that step — and only that
  step — is deferred.** For these releases the untrained first pass runs hard rules +
  LLM adjudication, the adjudicator navigating via the graph and exact fetch rather
  than a vector ranking. Both paths still satisfy one port; the trained Numbatch
  overlay engages as before once its sample floor is crossed. This narrows the
  untrained first pass until similarity search lands — accepted, on the ground that
  vector search is not a this-release-or-next capability, and the graph carries much
  of the navigation in the interim.

### Consequences

- **The near-term product mechanic is intact.** The report-assembler LLM has the
  graph to navigate, exact fetch to copy verbatim rows, and the embeddings available
  as data — everything ADR-0017 says it needs, minus a nearest-neighbour predicate it
  can do without for now.
- **Only the expensive, not-yet-needed part is deferred.** No ANN index to size, no
  recall/latency budget, no query-embed path — none of it enters the system before
  something depends on it. The "pain in the ass" of a half-used vector-search layer is
  not created yet.
- **The forward door is cheap *and* the substrate is ready.** The embeddings are
  already loaded and available in the store, so enabling similarity is *building an
  index over present data* + one adapter method — not a re-ingest, not a seam change.
  The store backing for that index (`pgvector` vs ANN-over-Parquet) stays an open
  follow-on ADR, decided *when RAG is built*, on real need.
- **The first-pass classifier is narrower in the interim** — no nearest-neighbour
  placing until similarity search lands; the graph + adjudication carry it. Accepted
  deliberately; revisit when a release makes vector search a requirement.
- **What this addendum defers, precisely:** the `pgvector` HNSW index; `findSimilar`;
  the store-side query-embed path; and the similarity clauses of the **Enforcement**
  exit test (the `findSimilar` ranking and mismatched-model-refusal assertions move to
  the deferred similarity thread). **What it does *not* defer:** the graph tools
  (**Decision → The tool/graph surface**, minus `find_similar`), the exact-fetch
  surface, and loading the embeddings into the store. The exit test that ships asserts
  exact `fetchChunks`/`fetchByStructure` return byte-identical rows for stable keys,
  the graph tools traverse `enrich` edges to reach those rows, and a chunk's embedding
  is retrievable as data.
