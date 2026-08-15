import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err, type Result } from "../result";
import { domainError } from "../errors/domain-error";
import type {
  ChunkRow,
  IChunkStore,
  ScoredChunkRef,
  StructureFilter,
} from "./chunk-store";

// The ADR-0018 store-side query surface, TypeScript side. This test is the
// port's spec: it proves the exact-fetch half is implementable as plain data
// (no vector ever crosses — validate.sh #4), and it pins the deferred half —
// findSimilar ships *declared* but unimplemented (NOT_IMPLEMENTED), so adding
// vector search later is additive, not a seam change (ADR-0018 addendum).

// A dependency-free in-memory store, the TS sibling of the sidecar's
// InMemoryChunkStore. Keyed on (evaluationId, chunkId); reads impose their own
// order so behaviour matches a real store. findSimilar is deliberately refused,
// not stubbed with a fake ranking — its absence of a real implementation is the
// guard that the deferred nearest-neighbour step was not built here.
class InMemoryChunkStore implements IChunkStore {
  private readonly rows = new Map<string, ChunkRow>();

  private key(evaluationId: string, chunkId: string): string {
    return `${evaluationId}\u0000${chunkId}`;
  }

  seed(evaluationId: string, rows: readonly ChunkRow[]): void {
    for (const row of rows) this.rows.set(this.key(evaluationId, row.chunkId), row);
  }

  async fetchChunks(
    evaluationId: string,
    chunkIds: readonly string[],
  ): Promise<Result<readonly ChunkRow[]>> {
    const found: ChunkRow[] = [];
    for (const chunkId of chunkIds) {
      const row = this.rows.get(this.key(evaluationId, chunkId));
      if (row !== undefined) found.push(row);
    }
    return ok(found);
  }

  async fetchByStructure(
    evaluationId: string,
    filter: StructureFilter,
  ): Promise<Result<readonly ChunkRow[]>> {
    const matches: ChunkRow[] = [];
    for (const [key, row] of this.rows) {
      if (!key.startsWith(`${evaluationId}\u0000`)) continue;
      if (filter.documentId !== undefined && row.documentId !== filter.documentId) continue;
      if (filter.contentType !== undefined && row.contentType !== filter.contentType) continue;
      if (filter.page !== undefined && row.page !== filter.page) continue;
      matches.push(row);
    }
    matches.sort((a, b) =>
      a.documentId === b.documentId
        ? a.chunkIndex - b.chunkIndex
        : a.documentId < b.documentId
          ? -1
          : 1,
    );
    return ok(matches);
  }

  async findSimilar(): Promise<Result<readonly ScoredChunkRef[]>> {
    // ADR-0018 addendum: vector similarity search is deferred. The port
    // declares it so a later release adds it without a seam change; until then
    // it refuses honestly rather than returning an empty or fake ranking.
    return err(
      domainError(
        "NOT_IMPLEMENTED",
        "findSimilar is deferred (ADR-0018 addendum) — the pgvector/ANN index is not built yet",
      ),
    );
  }
}

const row = (over: Partial<ChunkRow> & Pick<ChunkRow, "chunkId" | "chunkIndex">): ChunkRow => ({
  documentId: "hashA",
  contentType: "narrative",
  page: null,
  text: "a verbatim passage",
  startChar: null,
  endChar: null,
  elementOrder: null,
  ...over,
});

describe("IChunkStore — exact fetch (ADR-0018, exact half)", () => {
  it("returns rows for chunk ids in the requested order, byte-identical", async () => {
    const store = new InMemoryChunkStore();
    store.seed("e1", [
      row({ chunkId: "hashA:0", chunkIndex: 0, text: "first" }),
      row({ chunkId: "hashA:1", chunkIndex: 1, text: "second" }),
    ]);

    const fetched = await store.fetchChunks("e1", ["hashA:1", "hashA:0"]);
    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.data.map((r) => r.chunkId)).toEqual(["hashA:1", "hashA:0"]);
    expect(fetched.data[0].text).toBe("second");
  });

  it("omits a missing key rather than failing (exact lookup, not fuzzy)", async () => {
    const store = new InMemoryChunkStore();
    store.seed("e1", [row({ chunkId: "hashA:0", chunkIndex: 0 })]);

    const fetched = await store.fetchChunks("e1", ["hashA:0", "hashA:99"]);
    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.data.map((r) => r.chunkId)).toEqual(["hashA:0"]);
  });

  it("scopes rows to the evaluation — another evaluation's chunks never leak", async () => {
    const store = new InMemoryChunkStore();
    store.seed("e1", [row({ chunkId: "hashA:0", chunkIndex: 0, text: "mine" })]);
    store.seed("e2", [row({ chunkId: "hashA:0", chunkIndex: 0, text: "theirs" })]);

    const fetched = await store.fetchChunks("e1", ["hashA:0"]);
    if (!isOk(fetched)) throw new Error("fetch failed");
    expect(fetched.data[0].text).toBe("mine");
  });

  it("narrows by every set field of the structure filter, stable by provenance", async () => {
    const store = new InMemoryChunkStore();
    store.seed("e1", [
      row({ chunkId: "hashB:1", documentId: "hashB", chunkIndex: 1, contentType: "table", page: 2 }),
      row({ chunkId: "hashA:1", documentId: "hashA", chunkIndex: 1, contentType: "narrative", page: 1 }),
      row({ chunkId: "hashA:0", documentId: "hashA", chunkIndex: 0, contentType: "table", page: 1 }),
    ]);

    const tables = await store.fetchByStructure("e1", { contentType: "table" });
    expect(isOk(tables)).toBe(true);
    if (!isOk(tables)) return;
    // Ordered by (documentId, chunkIndex) — hashA:0 before hashB:1.
    expect(tables.data.map((r) => r.chunkId)).toEqual(["hashA:0", "hashB:1"]);

    const onePage = await store.fetchByStructure("e1", { documentId: "hashA", page: 1 });
    if (!isOk(onePage)) throw new Error("fetch failed");
    expect(onePage.data.map((r) => r.chunkId)).toEqual(["hashA:0", "hashA:1"]);
  });

  it("carries a chunk's provenance as plain data (no vector crosses the seam)", async () => {
    const store = new InMemoryChunkStore();
    store.seed("e1", [
      row({ chunkId: "hashA:3", documentId: "hashA", chunkIndex: 3, contentType: "table", page: 4 }),
    ]);
    const fetched = await store.fetchChunks("e1", ["hashA:3"]);
    if (!isOk(fetched)) throw new Error("fetch failed");
    const [only] = fetched.data;
    expect(only).toMatchObject({
      documentId: "hashA",
      chunkId: "hashA:3",
      chunkIndex: 3,
      contentType: "table",
      page: 4,
    });
    // The row is plain provenance + verbatim text — no embedding field at all.
    expect(only).not.toHaveProperty("embedding");
    expect(only).not.toHaveProperty("values");
  });
});

describe("IChunkStore — similarity discovery (ADR-0018 addendum: deferred)", () => {
  it("refuses findSimilar with NOT_IMPLEMENTED until vector search lands", async () => {
    const store = new InMemoryChunkStore();
    const scored = await store.findSimilar("e1", "query text", 5);
    expect(isErr(scored)).toBe(true);
    if (!isErr(scored)) return;
    expect(scored.error.code).toBe("NOT_IMPLEMENTED");
  });
});
