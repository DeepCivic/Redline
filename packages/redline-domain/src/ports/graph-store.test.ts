import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type { IGraphStore, GraphEntity, GraphEdge, GraphEntityQuery } from "./graph-store";

// Fake shaped against the 0c sample's real enrichment_entities.parquet /
// graph_edges.parquet rows — the signing officer "Janine Fairburn" (per:2)
// and her mentioned_in edge into chunk 3.
const DOCUMENT_ID = "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54";

class StubGraphStore implements IGraphStore {
  async findEntities(
    _corpusId: string,
    _runId: string,
    _documentId: string,
    query: GraphEntityQuery,
  ): Promise<Result<readonly GraphEntity[]>> {
    if (query.name !== "Janine Fairburn") return ok([]);
    return ok([
      {
        documentId: DOCUMENT_ID,
        entityId: "per:2",
        entityLabel: "person",
        name: "Janine Fairburn",
        entityType: "natural",
        role: "enacting_authority",
        mentions: [{ chunkIndex: 3, start: 4627, end: 4642 }],
      },
    ]);
  }

  async edgesFrom(): Promise<Result<readonly GraphEdge[]>> {
    return ok([
      {
        documentId: DOCUMENT_ID,
        sourceId: "per:2",
        targetId: "chunk:3",
        relation: "mentioned_in",
        properties: { start: "4627" },
      },
    ]);
  }

  async edgesTo(): Promise<Result<readonly GraphEdge[]>> {
    return ok([]);
  }
}

describe("port conformance (in-memory fake)", () => {
  it("resolves an entity by name, then walks its one-hop edges", async () => {
    const store: IGraphStore = new StubGraphStore();

    const entities = await store.findEntities("corpus-1", "run-1", DOCUMENT_ID, { name: "Janine Fairburn" });
    expect(isOk(entities)).toBe(true);
    if (!isOk(entities)) return;
    const entity = entities.data[0];
    expect(entity?.entityId).toBe("per:2");
    expect(entity?.mentions[0]?.chunkIndex).toBe(3);

    const edges = await store.edgesFrom("corpus-1", "run-1", DOCUMENT_ID, entity!.entityId);
    expect(isOk(edges)).toBe(true);
    if (!isOk(edges)) return;
    expect(edges.data[0]?.relation).toBe("mentioned_in");
  });
});
