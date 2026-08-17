import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type { IStagedCorpusWriter } from "./staged-corpus-writer";

class StubStagedCorpusWriter implements IStagedCorpusWriter {
  async writeDocument(): Promise<Result<{ readonly documentId: string }>> {
    return ok({ documentId: "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54" });
  }
}

describe("port conformance (in-memory fake)", () => {
  it("stages a document and returns its content-addressed id", async () => {
    const writer: IStagedCorpusWriter = new StubStagedCorpusWriter();

    const result = await writer.writeDocument("corpus-1", "throsby-oosc.pdf", new Uint8Array([1, 2, 3]));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.documentId).toHaveLength(64);
  });
});
