import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type { IStagedCorpusReader, StagedDocument } from "./staged-corpus-reader";

class StubStagedCorpusReader implements IStagedCorpusReader {
  async listDocuments(): Promise<Result<readonly StagedDocument[]>> {
    return ok([
      {
        documentId: "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54",
        filename: "throsby-oosc.pdf",
      },
    ]);
  }
}

describe("port conformance (in-memory fake)", () => {
  it("lists the documents staged into a corpus", async () => {
    const reader: IStagedCorpusReader = new StubStagedCorpusReader();

    const result = await reader.listDocuments("corpus-1");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]?.filename).toBe("throsby-oosc.pdf");
  });
});
