// DrizzleGraphStore — the enrichment-graph query surface (ADR-0017/0018) over the
// redline_ schema. Implements IGraphStore, so every method returns a Result and no
// driver exception crosses the port. Read-only: the sidecar's enrich load path
// writes redline_graph_entities / redline_graph_edges from womblex's
// `*.enrichment_entities.parquet` / `*.graph_edges.parquet`; this adapter only
// queries them.
//
// The report assembler traverses this graph to LOCATE source rows (entity →
// mentioned_in edge → chunk → verbatim text); it carries no interpretation of its
// own. Availability is a runtime condition: enrich is Isaacus spend and may not
// have run, in which case the tables are empty and every read is an empty result —
// never an error. The db handle is injected as a drizzle instance; the concrete
// driver (postgres-js in production, PGlite in tests) is the caller's choice.

import {
  domainError,
  err,
  ok,
  type EntityFilter,
  type GraphEdgeRow,
  type GraphEntityRow,
  type IGraphStore,
  type Result,
} from "@redline/redline-domain";
import { and, asc, eq, type SQL } from "drizzle-orm";
import {
  redlineGraphEdges,
  redlineGraphEntities,
  type GraphEdgeRow as GraphEdgeTableRow,
  type GraphEntityRow as GraphEntityTableRow,
} from "./schema";

// The minimal drizzle surface the store uses. Kept structural so both the
// postgres-js and PGlite drizzle instances satisfy it without a driver import.
interface RedlineDb {
  select: () => {
    from: (table: unknown) => {
      where: (predicate: unknown) => {
        orderBy: (...columns: unknown[]) => Promise<unknown[]>;
      };
    };
  };
}

const ENTITY_ORDER = [
  asc(redlineGraphEntities.documentId),
  asc(redlineGraphEntities.entityId),
  asc(redlineGraphEntities.mentionStart),
];

const EDGE_ORDER = [
  asc(redlineGraphEdges.targetId),
  asc(redlineGraphEdges.relation),
  asc(redlineGraphEdges.propKey),
];

const toEntityRow = (row: GraphEntityTableRow): GraphEntityRow => ({
  documentId: row.documentId,
  entityId: row.entityId,
  entityLabel: row.entityLabel,
  name: row.name,
  entityType: row.entityType,
  role: row.role,
  mentionStart: row.mentionStart,
  mentionEnd: row.mentionEnd,
  chunkIndex: row.chunkIndex,
});

const toEdgeRow = (row: GraphEdgeTableRow): GraphEdgeRow => ({
  documentId: row.documentId,
  sourceId: row.sourceId,
  targetId: row.targetId,
  relation: row.relation,
  propKey: row.propKey,
  propValue: row.propValue,
});

export class DrizzleGraphStore implements IGraphStore {
  private readonly db: RedlineDb;

  constructor(database: unknown) {
    this.db = database as RedlineDb;
  }

  async fetchEntities(
    evaluationId: string,
    filter: EntityFilter,
  ): Promise<Result<readonly GraphEntityRow[]>> {
    const predicates: SQL[] = [eq(redlineGraphEntities.evaluationId, evaluationId)];
    if (filter.documentId !== undefined) {
      predicates.push(eq(redlineGraphEntities.documentId, filter.documentId));
    }
    if (filter.entityLabel !== undefined) {
      predicates.push(eq(redlineGraphEntities.entityLabel, filter.entityLabel));
    }
    if (filter.chunkIndex !== undefined) {
      predicates.push(eq(redlineGraphEntities.chunkIndex, filter.chunkIndex));
    }
    try {
      const rows = (await this.db
        .select()
        .from(redlineGraphEntities)
        .where(and(...predicates))
        .orderBy(...ENTITY_ORDER)) as GraphEntityTableRow[];
      return ok(rows.map(toEntityRow));
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "failed to read graph entities", cause));
    }
  }

  async fetchEdgesFrom(
    evaluationId: string,
    entityId: string,
  ): Promise<Result<readonly GraphEdgeRow[]>> {
    return this.queryEdges(
      and(
        eq(redlineGraphEdges.evaluationId, evaluationId),
        eq(redlineGraphEdges.sourceId, entityId),
      ),
      "failed to read graph edges from entity",
    );
  }

  async fetchEdgesTo(
    evaluationId: string,
    entityId: string,
  ): Promise<Result<readonly GraphEdgeRow[]>> {
    return this.queryEdges(
      and(
        eq(redlineGraphEdges.evaluationId, evaluationId),
        eq(redlineGraphEdges.targetId, entityId),
      ),
      "failed to read graph edges to entity",
    );
  }

  private async queryEdges(
    predicate: unknown,
    failureMessage: string,
  ): Promise<Result<readonly GraphEdgeRow[]>> {
    try {
      const rows = (await this.db
        .select()
        .from(redlineGraphEdges)
        .where(predicate)
        .orderBy(...EDGE_ORDER)) as GraphEdgeTableRow[];
      return ok(rows.map(toEdgeRow));
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", failureMessage, cause));
    }
  }
}
