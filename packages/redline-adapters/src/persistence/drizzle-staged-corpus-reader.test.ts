import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isOk, isErr } from "@redline/redline-domain";
import { applyMigrations } from "./apply-migrations";
import { schema } from "./db";
import { redlineChunks, type NewChunkRow } from "./schema";
import { DrizzleStagedCorpusReader } from "./drizzle-staged-corpus-reader";

// A real Postgres round-trip in-process (PGlite), loaded from the same migration
// SQL that ships. The reader is read-only over the rows the womblex-ingest
// sidecar's load path writes, so the test seeds redline_chunks directly — the
// same standing-in-for-Python the chunk-store suite does.
//
// What is being proven is that the create screen can offer real choices: the
// corpora that have been staged, the documents behind each, and enough of each
// document's opening text to tell one tender response from another.

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
let reader: DrizzleStagedCorpusReader;

const seedChunk = async (over: Partial<NewChunkRow> & { chunkId: string; chunkIndex: number }) => {
  const row: NewChunkRow = {
    evaluationId: "tender-2026-water",
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
  reader = new DrizzleStagedCorpusReader(database);
});

afterEach(async () => {
  await pg.close();
});

describe("DrizzleStagedCorpusReader — listing staged corpora", () => {
  it("counts documents, not chunks, so the picker shows what an operator staged", async () => {
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0 });
    await seedChunk({ chunkId: "hashA:1", chunkIndex: 1 });
    await seedChunk({ chunkId: "hashB:0", chunkIndex: 0, sourceHash: "hashB" });
    await seedChunk({
      chunkId: "hashC:0",
      chunkIndex: 0,
      sourceHash: "hashC",
      evaluationId: "tender-2026-roads",
    });

    const corpora = await reader.listCorpora();

    expect(isOk(corpora)).toBe(true);
    if (!isOk(corpora)) return;
    expect(corpora.data).toEqual([
      { corpusId: "tender-2026-roads", documentCount: 1 },
      { corpusId: "tender-2026-water", documentCount: 2 },
    ]);
  });

  it("lists nothing on an empty store rather than failing", async () => {
    const corpora = await reader.listCorpora();

    expect(isOk(corpora)).toBe(true);
    if (!isOk(corpora)) return;
    expect(corpora.data).toEqual([]);
  });
});

describe("DrizzleStagedCorpusReader — listing a corpus's documents", () => {
  it("returns each document's chunk count and its opening passage", async () => {
    await seedChunk({ chunkId: "hashB:0", chunkIndex: 0, sourceHash: "hashB", text: "Response of Beta Pty Ltd" });
    await seedChunk({ chunkId: "hashB:1", chunkIndex: 1, sourceHash: "hashB", text: "later text" });
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0, sourceHash: "hashA", text: "Response of Alpha Pty Ltd" });

    const documents = await reader.listDocuments("tender-2026-water");

    expect(isOk(documents)).toBe(true);
    if (!isOk(documents)) return;
    expect(documents.data).toEqual([
      { documentId: "hashA", chunkCount: 1, preview: "Response of Alpha Pty Ltd" },
      { documentId: "hashB", chunkCount: 2, preview: "Response of Beta Pty Ltd" },
    ]);
  });

  it("excludes documents staged under a different corpus", async () => {
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0 });
    await seedChunk({
      chunkId: "hashC:0",
      chunkIndex: 0,
      sourceHash: "hashC",
      evaluationId: "tender-2026-roads",
    });

    const documents = await reader.listDocuments("tender-2026-water");

    expect(isOk(documents)).toBe(true);
    if (!isOk(documents)) return;
    expect(documents.data.map((staged) => staged.documentId)).toEqual(["hashA"]);
  });

  it("truncates a long opening passage so one document cannot flood the picker", async () => {
    await seedChunk({ chunkId: "hashA:0", chunkIndex: 0, text: "x".repeat(400) });

    const documents = await reader.listDocuments("tender-2026-water");

    expect(isOk(documents)).toBe(true);
    if (!isOk(documents)) return;
    expect(documents.data[0]?.preview.length).toBeLessThanOrEqual(200);
  });

  it("still lists a document whose first chunk is missing, with an empty preview", async () => {
    await seedChunk({ chunkId: "hashA:4", chunkIndex: 4, text: "a middle passage" });

    const documents = await reader.listDocuments("tender-2026-water");

    expect(isOk(documents)).toBe(true);
    if (!isOk(documents)) return;
    expect(documents.data).toEqual([{ documentId: "hashA", chunkCount: 1, preview: "" }]);
  });

  it("refuses a corpus nothing has staged", async () => {
    const documents = await reader.listDocuments("never-staged");

    expect(isErr(documents)).toBe(true);
    if (!isErr(documents)) return;
    expect(documents.error.code).toBe("NOT_FOUND");
  });
});
