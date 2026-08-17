import type { Result } from "../result";

// Reads the enrichment graph from a womblex run (ENTITY_SCHEMA +
// GRAPH_EDGE_SCHEMA). Scoped to entity resolution and one-hop lookup only
// (§4) — a navigation aid to a chunk, never evidence itself.
//
// Measured against the 0c sample: graph_edges node ids are namespaced
// "{documentId}:{entityId}" (e.g. "{hash}:per:0"), not the bare entity_id
// ENTITY_SCHEMA carries. That encoding is adapter plumbing the caller should
// never need to know — findEntities returns the bare entityId, and
// edgesFrom/edgesTo take it back the same way.
//
// ENTITY_SCHEMA is mention-grain (one row per mention span); this port
// re-normalises to one row per entity with its mentions nested, since a
// caller reasons about one entity, not N mention rows. GRAPH_EDGE_SCHEMA is
// similarly denormalised (one row per edge-property pair) and re-normalised
// to one edge with a properties map here.

export interface GraphEntityMention {
  readonly chunkIndex: number | null; // null when the shard's chunk_index is -1 (not mapped)
  readonly start: number;
  readonly end: number;
}

export interface GraphEntity {
  readonly documentId: string;
  readonly entityId: string; // bare id, e.g. "per:0"
  readonly entityLabel: string; // person | location | term | external_document
  readonly name: string;
  readonly entityType: string;
  readonly role: string | null;
  readonly mentions: readonly GraphEntityMention[];
}

export interface GraphEdge {
  readonly documentId: string;
  readonly sourceId: string; // bare entity id, or the document/chunk/segment node it names
  readonly targetId: string;
  readonly relation: string;
  readonly properties: Readonly<Record<string, string>>;
}

export interface GraphEntityQuery {
  readonly name?: string;
  readonly entityLabel?: string;
}

export interface IGraphStore {
  findEntities(
    corpusId: string,
    runId: string,
    documentId: string,
    query: GraphEntityQuery,
  ): Promise<Result<readonly GraphEntity[]>>;

  edgesFrom(corpusId: string, runId: string, documentId: string, entityId: string): Promise<Result<readonly GraphEdge[]>>;

  edgesTo(corpusId: string, runId: string, documentId: string, entityId: string): Promise<Result<readonly GraphEdge[]>>;
}
