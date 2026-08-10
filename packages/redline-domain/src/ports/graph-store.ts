import type { Result } from "../result";

// The enrichment-graph query surface (ADR-0017/0018), TypeScript side. womblex's
// `enrich` stage lands two sidecars — `*.enrichment_entities.parquet` (entity
// mentions) and `*.graph_edges.parquet` (directed edges) — which are materialised
// into redline's `redline_` store and queried in place, never parsed in
// TypeScript (ADR-0017). This port is the domain's view of that store, plain data
// by construction so `redline-domain` purity (validate.sh #4) keeps it
// Parquet/Arrow-free. A sibling of `IChunkStore` and `IMoneySpanStore`: the same
// provenance-addressed reads, over the graph instead of text or money.
//
// **This is the report assembler's navigation mechanic, not vector search**
// (ADR-0017/0018). An entity mention carries the `chunkIndex` it was found in, so
// a traversal — entity → its mentioned_in edges → the chunk it names — lands the
// assembler on a stable chunkId it then reads verbatim through `IChunkStore`. The
// graph is *how* the right source rows are located; the transfer itself is still
// an exact, byte-identical chunk fetch.
//
// **Availability is a runtime condition, not a design input** (delivery-plan §2,
// architecture §5 invariant 7). enrich is real Isaacus spend and may not have run;
// when it has not, every read here is an *empty result*, never an error — "the
// graph is not here". The tool surface reports that as an explicit unavailability
// and never silently degrades a report to a thinner one; the store just answers
// with what it holds, which is nothing.

// womblex's entity labels (`ENTITY_SCHEMA.entity_label`): the kinds of thing the
// enricher recognises. Carried as an open string rather than a closed enum,
// because it is upstream's vocabulary and a new label must not need a redline
// change to pass through uninterpreted.
export type GraphEntityLabel = string;

// One entity mention, as womblex wrote it (`ENTITY_SCHEMA`,
// `services/womblex/src/womblex/store/enrichment_output.py`) with `source_hash`
// renamed to `documentId` and columns camel-cased. Nothing is interpreted on the
// way in.
//
// `chunkIndex` is the join back to verbatim text: it is the chunk the mention
// falls in, so `{documentId}:{chunkIndex}` is the stable `chunkId` a caller then
// reads through `IChunkStore.fetchChunks`. womblex writes **-1 when a mention did
// not map to a chunk** (AI chunking before the graph refresh), so a consumer must
// treat -1 as "no chunk", not as chunk 0.
export interface GraphEntityRow {
  readonly documentId: string; // womblex source_hash
  readonly entityId: string; // e.g. "{source_hash}:per:0"
  readonly entityLabel: GraphEntityLabel; // person | location | term | external_document
  readonly name: string; // the mention's surface text
  readonly entityType: string; // natural | corporate | country | … ("" when not typed)
  readonly role: string; // seller | buyer | other (persons only; "" otherwise)
  readonly mentionStart: number; // char offset into the reassembled narrative
  readonly mentionEnd: number;
  readonly chunkIndex: number; // the chunk the mention falls in, or -1 when unmapped
}

// One directed graph edge, as womblex wrote it (`GRAPH_EDGE_SCHEMA`). womblex
// flattens edge properties to one row per (edge, property) pair, so a property-less
// edge is a single row with empty `propKey`/`propValue`, and an edge with several
// properties repeats across rows sharing `sourceId`/`targetId`/`relation`.
export interface GraphEdgeRow {
  readonly documentId: string; // womblex source_hash
  readonly sourceId: string; // an entityId, a chunk id ("{hash}:chunk:{i}"), or a doc id
  readonly targetId: string;
  readonly relation: string; // mentioned_in | cites | co_occurs | …
  readonly propKey: string; // "" when the edge carries no properties
  readonly propValue: string;
}

// A structural predicate over entity mentions. Every field is optional; a set
// field narrows the result, an unset one is ignored. Mirrors `IChunkStore`'s
// `StructureFilter`. `chunkIndex` addresses the entities that fall in one chunk —
// the reverse of the `entityId → chunk` traversal, so a caller holding a chunk can
// find what it mentions.
export interface EntityFilter {
  readonly documentId?: string;
  readonly entityLabel?: GraphEntityLabel;
  readonly chunkIndex?: number;
}

export interface IGraphStore {
  // The entity mentions matching every set field of `filter`, in a stable order
  // (documentId, entityId, mentionStart). An empty result is a loaded-but-empty
  // graph or no graph at all — the store does not distinguish, and neither
  // outcome is an error.
  fetchEntities(
    evaluationId: string,
    filter: EntityFilter,
  ): Promise<Result<readonly GraphEntityRow[]>>;

  // The edges leaving `entityId` (its `sourceId`), in a stable order
  // (targetId, relation, propKey). The out-traversal step: entity → what it
  // relates to, including the `mentioned_in` chunk edge the assembler follows to
  // reach verbatim text.
  fetchEdgesFrom(
    evaluationId: string,
    entityId: string,
  ): Promise<Result<readonly GraphEdgeRow[]>>;

  // The edges arriving at `entityId` (its `targetId`), in the same stable order.
  // The in-traversal step: what relates *to* a node — e.g. every entity mentioned
  // in a given chunk.
  fetchEdgesTo(
    evaluationId: string,
    entityId: string,
  ): Promise<Result<readonly GraphEdgeRow[]>>;
}
