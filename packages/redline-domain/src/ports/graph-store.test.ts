import { describe, it, expect } from "vitest";
import { isOk, ok } from "../result";
import type {
  EntityFilter,
  GraphEdgeRow,
  GraphEntityRow,
  IGraphStore,
} from "./graph-store";
import type { Result } from "../result";

// The port's spec, proved against a dependency-free in-memory graph. The store
// carries womblex's enrich output uninterpreted: entity mentions keyed by
// chunk_index (the join back to verbatim chunk text) and directed edges. When no
// enrich run has loaded a graph, every read is an empty result — "the graph is not
// here", which the caller reports as an unavailability rather than a thinner answer.

const entity = (over: Partial<GraphEntityRow> = {}): GraphEntityRow => ({
  documentId: "hashA",
  entityId: "hashA:per:0",
  entityLabel: "person",
  name: "Jane Doe",
  entityType: "natural",
  role: "seller",
  mentionStart: 10,
  mentionEnd: 18,
  chunkIndex: 3,
  ...over,
});

const edge = (over: Partial<GraphEdgeRow> = {}): GraphEdgeRow => ({
  documentId: "hashA",
  sourceId: "hashA:per:0",
  targetId: "hashA:chunk:3",
  relation: "mentioned_in",
  propKey: "start",
  propValue: "10",
  ...over,
});

class InMemoryGraphStore implements IGraphStore {
  constructor(
    private readonly entities: readonly GraphEntityRow[],
    private readonly edges: readonly GraphEdgeRow[],
  ) {}

  private scoped<T extends { documentId: string }>(
    rows: readonly T[],
    evaluationId: string,
  ): readonly T[] {
    // The in-memory double ignores evaluation scope beyond presence; a real store
    // partitions by it. Kept so the double never leaks another evaluation's rows.
    return evaluationId === "eval-1" ? rows : [];
  }

  async fetchEntities(
    evaluationId: string,
    filter: EntityFilter,
  ): Promise<Result<readonly GraphEntityRow[]>> {
    const rows = this.scoped(this.entities, evaluationId).filter((row) => {
      if (filter.documentId !== undefined && row.documentId !== filter.documentId) return false;
      if (filter.entityLabel !== undefined && row.entityLabel !== filter.entityLabel) return false;
      if (filter.chunkIndex !== undefined && row.chunkIndex !== filter.chunkIndex) return false;
      return true;
    });
    return ok(rows);
  }

  async fetchEdgesFrom(
    evaluationId: string,
    entityId: string,
  ): Promise<Result<readonly GraphEdgeRow[]>> {
    return ok(this.scoped(this.edges, evaluationId).filter((row) => row.sourceId === entityId));
  }

  async fetchEdgesTo(
    evaluationId: string,
    entityId: string,
  ): Promise<Result<readonly GraphEdgeRow[]>> {
    return ok(this.scoped(this.edges, evaluationId).filter((row) => row.targetId === entityId));
  }
}

describe("IGraphStore", () => {
  it("filters entities by every set field", async () => {
    const store = new InMemoryGraphStore(
      [
        entity({ entityId: "e0", entityLabel: "person", chunkIndex: 3 }),
        entity({ entityId: "e1", entityLabel: "location", chunkIndex: 3 }),
        entity({ entityId: "e2", entityLabel: "person", chunkIndex: 7 }),
      ],
      [],
    );

    const result = await store.fetchEntities("eval-1", { entityLabel: "person", chunkIndex: 3 });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.entityId)).toEqual(["e0"]);
  });

  it("follows edges out of an entity", async () => {
    const store = new InMemoryGraphStore(
      [],
      [
        edge({ sourceId: "e0", targetId: "hashA:chunk:3" }),
        edge({ sourceId: "e0", targetId: "hashA:loc:1", relation: "co_occurs" }),
        edge({ sourceId: "e9", targetId: "hashA:chunk:5" }),
      ],
    );

    const result = await store.fetchEdgesFrom("eval-1", "e0");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.targetId)).toEqual(["hashA:chunk:3", "hashA:loc:1"]);
  });

  it("follows edges into an entity", async () => {
    const store = new InMemoryGraphStore(
      [],
      [edge({ sourceId: "e0", targetId: "t1" }), edge({ sourceId: "e2", targetId: "t1" })],
    );

    const result = await store.fetchEdgesTo("eval-1", "t1");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.sourceId)).toEqual(["e0", "e2"]);
  });

  it("returns an empty result when no graph is loaded — absent, not an error", async () => {
    const store = new InMemoryGraphStore([], []);

    const entities = await store.fetchEntities("eval-1", {});
    const edges = await store.fetchEdgesFrom("eval-1", "e0");

    expect(isOk(entities)).toBe(true);
    expect(isOk(edges)).toBe(true);
    if (!isOk(entities) || !isOk(edges)) return;
    expect(entities.data).toEqual([]);
    expect(edges.data).toEqual([]);
  });

  it("never leaks another evaluation's rows", async () => {
    const store = new InMemoryGraphStore([entity()], [edge()]);

    const result = await store.fetchEntities("eval-2", {});

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([]);
  });
});
