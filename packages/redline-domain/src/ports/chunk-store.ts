import type { Result } from "../result";

// The store-side query surface (ADR-0018), TypeScript side. It replaces
// ADR-0014's `IEmbeddingReader` (a reader returning `Float32Array` vectors) with
// a provenance-addressed surface whose results are *addressable rows*, never raw
// vectors. At the measured ~90k-chunk corpus, vectors do not cross into
// TypeScript (ADR-0017); the sidecar loads womblex's Parquet into redline's
// `redline_` store and answers these queries in place. This port is
// the domain's view of that store — plain data by construction, so
// `redline-domain` purity (validate.sh #4) keeps it Parquet/Arrow/vector-free.
//
// Two operations ship now (ADR-0018 addendum): exact fetch by stable key and
// structural fetch by provenance — the deterministic *transfer* mechanic, which
// an LLM report-assembler copies verbatim into a template slot. A third,
// `findSimilar`, is *declared* but deferred: the nearest-neighbour predicate
// needs the `pgvector`/ANN index that is not built this release, so an
// implementation refuses with NOT_IMPLEMENTED until vector search lands. The
// port carries it so adding it later is additive, not a seam change.
//
// The cold-start `IProcurementClassifier` reads this surface for the
// passages the LLM adjudicates over — hard rules + adjudication over exact
// fetch, *without* the deferred nearest-neighbour step.

// One addressable chunk in the store, with full provenance and its verbatim
// text. Mirrors the sidecar's `ChunkRow` (womblex-ingest `chunk_store.py`). The
// vector is deliberately absent: it never crosses the seam (ADR-0017), so the
// domain sees a chunk's *identity, structure and text*, and reaches its vector —
// when a future release needs it — only through the store, keyed on `chunkId`.
export interface ChunkRow {
  readonly documentId: string; // womblex source_hash
  readonly chunkId: string; // "{source_hash}:{chunk_index}" — the stable key (ADR-0014)
  readonly chunkIndex: number; // the explicit ordinal, so a consumer joins without parsing
  readonly contentType: string; // womblex's own tag (e.g. "narrative", "table")
  readonly page: number | null; // a legitimate nullable — not every chunk carries a page
  readonly text: string; // verbatim, byte-identical — copied into report slots, never paraphrased
  // The element range this chunk was cut from (delivery-plan "Chunk element
  // addressing"), so a money span resolves to the one chunk containing it rather
  // than to its whole document. Optional, not just nullable: dozens of existing
  // ChunkRow literals across the suite predate this field, and requiring it on
  // every one of them would widen this change well past the store that produces
  // it. `DrizzleChunkStore` always populates all three going forward.
  //   narrative chunk — startChar/endChar, the same reassemble_narrative
  //     coordinate space MoneySpanRow's narrative locus reads; elementOrder null
  //     (a narrative chunk straddles several elements).
  //   table chunk — elementOrder, the table element it was cut from (null for a
  //     spreadsheet-sheet table chunk, which has no single anchor element);
  //     startChar/endChar null (offsets are into table markdown, not narrative).
  readonly startChar?: number | null;
  readonly endChar?: number | null;
  readonly elementOrder?: number | null;
}

// A structural predicate over the exact-fetch surface. Every field is optional;
// a set field narrows the result, an unset one is ignored. This is the
// addressing half (document / content_type / page) — not a similarity query.
// Table (row, col) and heading filters join through the element/cell shards and
// are added when a consumer needs them (mirrors the sidecar's StructureFilter).
export interface StructureFilter {
  readonly documentId?: string;
  readonly contentType?: string;
  readonly page?: number;
}

// A similarity hit: a key + score only, never a vector (ADR-0018). A consumer
// that will copy the text then `fetchChunks` the referenced keys, so the
// transfer is always an exact, deterministic read. This shape exists so the
// deferred `findSimilar` is fully typed; nothing produces it this release.
export interface ScoredChunkRef {
  readonly chunkId: string;
  readonly score: number;
}

export interface IChunkStore {
  // Exact, deterministic — the transfer mechanic. Returns the rows for
  // `chunkIds` in the requested order; a missing key is simply absent from the
  // result (an exact lookup, not a fuzzy match), so the caller sees which keys
  // resolved by what comes back.
  fetchChunks(
    evaluationId: string,
    chunkIds: readonly string[],
  ): Promise<Result<readonly ChunkRow[]>>;

  // Structural addressing — the rows matching every set field of `filter`,
  // ordered by (documentId, chunkIndex) so the result is stable.
  fetchByStructure(
    evaluationId: string,
    filter: StructureFilter,
  ): Promise<Result<readonly ChunkRow[]>>;

  // Discovery — one predicate, deferred (ADR-0018 addendum). Similarity would
  // run in the store and only keyed candidates cross the seam, never the vectors;
  // the query text is embedded store-side by the model the chunks declare, or
  // the match is refused (ADR-0014). Until the `pgvector`/ANN index is built, an
  // implementation returns a NOT_IMPLEMENTED DomainError. Declared here so
  // enabling it later is additive.
  findSimilar(
    evaluationId: string,
    queryText: string,
    k: number,
    filter?: StructureFilter,
  ): Promise<Result<readonly ScoredChunkRef[]>>;
}
