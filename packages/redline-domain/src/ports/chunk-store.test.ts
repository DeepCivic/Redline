import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type { IChunkStore, Chunk } from "./chunk-store";

// Fake shaped against the 0c sample's real chunks.parquet row (chunk_index 2,
// the one carrying the penalty amounts).
const DOCUMENT_ID = "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54";

class StubChunkStore implements IChunkStore {
  async readChunks(): Promise<Result<readonly Chunk[]>> {
    return ok([
      {
        chunkId: `${DOCUMENT_ID}:2`,
        documentId: DOCUMENT_ID,
        chunkIndex: 2,
        text: "Penalty: $10 000, in the case of an individual $50 000, in any other case.",
        startChar: 2205,
        endChar: 3624,
        contentType: "narrative",
        hasRedaction: false,
        pageStart: 1,
        pageEnd: 1,
        elemOrder: null,
      },
    ]);
  }
}

describe("port conformance (in-memory fake)", () => {
  it("reads a run-scoped document's chunks", async () => {
    const store: IChunkStore = new StubChunkStore();

    const result = await store.readChunks("corpus-1", "run-1", DOCUMENT_ID);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]?.chunkId).toBe(`${DOCUMENT_ID}:2`);
    expect(result.data[0]?.text).toContain("$10 000");
  });
});
