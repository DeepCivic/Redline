import { describe, it, expect } from "vitest";
import { isOk, ok, type Result } from "../result";
import type {
  IWomblexAssetReader,
  ShardPage,
  WomblexAssetRequest,
} from "./womblex-asset-reader";

// This fake proves the asset-reader port is implementable and shaped as its
// adapter needs. It is the port's spec: verbatim womblex columns, honest paging.

class StubAssetReader implements IWomblexAssetReader {
  async readShard(request: WomblexAssetRequest): Promise<Result<ShardPage>> {
    const rows = [
      { source_hash: "hashA", elem_order: 0, page: 1, text: "Acme response" },
      { source_hash: "hashA", elem_order: 1, page: 1, text: "second element" },
    ];
    const offset = request.offset ?? 0;
    const limit = request.limit ?? rows.length;
    const window = rows.slice(offset, offset + limit);
    return ok({
      asset: request.asset,
      runId: request.runId,
      columns: [
        { name: "source_hash", type: "string" },
        { name: "elem_order", type: "int32" },
        { name: "page", type: "int32" },
        { name: "text", type: "string" },
      ],
      rows: window,
      returned: window.length,
      available: rows.length,
      truncated: offset + window.length < rows.length,
    });
  }
}

describe("port conformance (in-memory fake)", () => {
  it("reads a shard page with womblex's own column names, verbatim", async () => {
    const reader: IWomblexAssetReader = new StubAssetReader();

    const page = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "elements",
    });

    expect(isOk(page)).toBe(true);
    if (!isOk(page)) return;
    expect(page.data.rows[0]).toHaveProperty("source_hash", "hashA");
    expect(page.data.rows[0]).toHaveProperty("elem_order", 0);
    expect(page.data.rows[0]).not.toHaveProperty("documentId");
    expect(page.data.columns.map((column) => column.name)).toContain("elem_order");
  });

  it("pages: a second page continues where the first stopped", async () => {
    const reader: IWomblexAssetReader = new StubAssetReader();

    const first = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "elements",
      limit: 1,
      offset: 0,
    });
    const second = await reader.readShard({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      asset: "elements",
      limit: 1,
      offset: 1,
    });

    expect(isOk(first) && isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.data.truncated).toBe(true);
    expect(second.data.truncated).toBe(false);
    expect(first.data.rows[0]).not.toEqual(second.data.rows[0]);
  });
});
