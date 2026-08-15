import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isOk } from "@redline/redline-domain";
import { applyMigrations } from "./apply-migrations";
import { schema } from "./db";
import { redlineChunks, type NewChunkRow } from "./schema";
import { DrizzleChunkStore } from "./drizzle-chunk-store";

// A real Postgres round-trip in-process (PGlite = Postgres in WASM), loaded from
// the same migration SQL that ships. The store is read-only over rows the
// sidecar's load path writes; here the test seeds redline_chunks directly
// (standing in for that Python load) so the query surface is provable without
// the sidecar. The embedding column is populated to prove it NEVER crosses the
// seam — the domain ChunkRow has no vector (ADR-0017, validate.sh #4).

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
let store: DrizzleChunkStore;

const seedChunk = async (over: Partial<NewChunkRow> & { chunkId: string; chunkIndex: number }) => {
  const row: NewChunkRow = {
    evaluationId: "eval-1",
    sourceHash: "hashA",
    contentType: "narrative",
    page: null,
    text: "a verbatim passage",
    embedding: [0.1, 0.2, 0.3],
    embeddingModel: "kanon-2-embedder",
    ...over,
  };
  await database.insert(redlineChunks).values(row);
};

beforeEach(async () => {
  pg = new PGlite();
  await applyMigrations((sql) => pg.exec(sql));
  database = drizzle(pg, { schema });
  store = new DrizzleChunkStore(database);
});

afterEach(async () => {
  await pg.close();
});

describe("DrizzleChunkStore — exact fetch (ADR-0018, exact half)", () => {
  it("returns rows for chunk ids in the requested order, byte-identical", async () => {
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0, text: "first" });
    await seedChunk({ chunkId: "hashA:1", chunkIndex: 1, text: "second" });

    const fetched = await store.fetchChunks("eval-1", ["hashA:1", "hashA:0"]);

    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.data.map((r) => r.chunkId)).toEqual(["hashA:1", "hashA:0"]);
    expect(fetched.data[0]!.text).toBe("second");
  });

  it("omits a missing key rather than failing (exact lookup, not fuzzy)", async () => {
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0 });

    const fetched = await store.fetchChunks("eval-1", ["hashA:0", "hashA:99"]);

    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.data.map((r) => r.chunkId)).toEqual(["hashA:0"]);
  });

  it("returns an empty result for an empty id list, without touching the db", async () => {
    const fetched = await store.fetchChunks("eval-1", []);
    expect(isOk(fetched)).toBe(true);
    if (!isOk(fetched)) return;
    expect(fetched.data).toEqual([]);
  });

  it("scopes rows to the evaluation — another evaluation's chunks never leak", async () => {
    await seedChunk({ evaluationId: "eval-1", chunkId: "hashA:0", chunkIndex: 0, text: "mine" });
    await seedChunk({ evaluationId: "eval-2", chunkId: "hashA:0", chunkIndex: 0, text: "theirs" });

    const fetched = await store.fetchChunks("eval-1", ["hashA:0"]);

    if (!isOk(fetched)) throw new Error("fetch failed");
    expect(fetched.data[0]!.text).toBe("mine");
  });

  it("never selects the embedding — no vector crosses the seam (ADR-0017)", async () => {
    await seedChunk({
      chunkId: "hashA:3",
      chunkIndex: 3,
      contentType: "table",
      page: 4,
      embedding: [0.9, 0.8, 0.7],
    });

    const fetched = await store.fetchChunks("eval-1", ["hashA:3"]);

    if (!isOk(fetched)) throw new Error("fetch failed");
    const [only] = fetched.data;
    expect(only).toMatchObject({
      documentId: "hashA",
      chunkId: "hashA:3",
      chunkIndex: 3,
      contentType: "table",
      page: 4,
      text: "a verbatim passage",
    });
    expect(only).not.toHaveProperty("embedding");
    expect(only).not.toHaveProperty("embeddingModel");
    expect(only).not.toHaveProperty("values");
  });

  it("carries the element range a chunk was cut from (delivery-plan: chunk element addressing)", async () => {
    await seedChunk({
      chunkId: "hashA:0",
      chunkIndex: 0,
      contentType: "narrative",
      startChar: 120,
      endChar: 480,
    });
    await seedChunk({
      chunkId: "hashA:1",
      chunkIndex: 1,
      contentType: "table",
      startChar: null,
      endChar: null,
      elementOrder: 7,
    });

    const fetched = await store.fetchChunks("eval-1", ["hashA:0", "hashA:1"]);

    if (!isOk(fetched)) throw new Error("fetch failed");
    expect(fetched.data[0]).toMatchObject({ startChar: 120, endChar: 480, elementOrder: null });
    expect(fetched.data[1]).toMatchObject({ startChar: null, endChar: null, elementOrder: 7 });
  });
});

describe("DrizzleChunkStore — structural fetch", () => {
  it("narrows by every set field of the filter, stable by (documentId, chunkIndex)", async () => {
    await seedChunk({ chunkId: "hashB:1", sourceHash: "hashB", chunkIndex: 1, contentType: "table", page: 2 });
    await seedChunk({ chunkId: "hashA:1", sourceHash: "hashA", chunkIndex: 1, contentType: "narrative", page: 1 });
    await seedChunk({ chunkId: "hashA:0", sourceHash: "hashA", chunkIndex: 0, contentType: "table", page: 1 });

    const tables = await store.fetchByStructure("eval-1", { contentType: "table" });

    expect(isOk(tables)).toBe(true);
    if (!isOk(tables)) return;
    // Ordered by (documentId, chunkIndex) — hashA:0 before hashB:1.
    expect(tables.data.map((r) => r.chunkId)).toEqual(["hashA:0", "hashB:1"]);
  });

  it("addresses a whole document by documentId, in chunk order", async () => {
    await seedChunk({ chunkId: "hashA:1", chunkIndex: 1, text: "second" });
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0, text: "first" });
    await seedChunk({ chunkId: "hashB:0", sourceHash: "hashB", chunkIndex: 0, text: "other doc" });

    const doc = await store.fetchByStructure("eval-1", { documentId: "hashA" });

    if (!isOk(doc)) throw new Error("fetch failed");
    expect(doc.data.map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("combines document and page filters", async () => {
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0, page: 1 });
    await seedChunk({ chunkId: "hashA:1", chunkIndex: 1, page: 2 });

    const onePage = await store.fetchByStructure("eval-1", { documentId: "hashA", page: 1 });

    if (!isOk(onePage)) throw new Error("fetch failed");
    expect(onePage.data.map((r) => r.chunkId)).toEqual(["hashA:0"]);
  });

  it("returns an empty result for a document with no chunks, not an error", async () => {
    const result = await store.fetchByStructure("eval-1", { documentId: "no-such-doc" });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([]);
  });

  it("carries a null page as null, not zero", async () => {
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0, page: null });

    const result = await store.fetchByStructure("eval-1", { documentId: "hashA" });

    if (!isOk(result)) throw new Error("fetch failed");
    expect(result.data[0]!.page).toBeNull();
  });
});

describe("DrizzleChunkStore — deferred similarity (ADR-0018 addendum)", () => {
  it("refuses findSimilar with NOT_IMPLEMENTED until vector search lands", async () => {
    const scored = await store.findSimilar("eval-1", "query text", 5);
    expect(isOk(scored)).toBe(false);
    if (isOk(scored)) return;
    expect(scored.error.code).toBe("NOT_IMPLEMENTED");
  });
});

describe("redline_chunks migration idempotency", () => {
  it("applies the migration a second time without error", async () => {
    await expect(applyMigrations((sql) => pg.exec(sql))).resolves.toBeUndefined();
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0 });
    const result = await store.fetchByStructure("eval-1", { documentId: "hashA" });
    expect(isOk(result)).toBe(true);
  });
});
