import { describe, it, expect } from "vitest";
import { isOk, ok, type Result } from "../result";
import type {
  IWomblexAssetReader,
  ShardPage,
  WomblexAssetRequest,
} from "./womblex-asset-reader";
import type {
  AssetShape,
  CorpusShape,
  IWomblexShapeReader,
  WomblexShapeRequest,
} from "./womblex-shape-reader";

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

// The shape port's spec: aggregate metadata about rows, never rows. A client
// sizes a read through this before making one, so what it must carry is counts
// per run, kept apart per run, and — at document scope — the tallies that let a
// retrieval be narrowed instead of paged.

class StubShapeReader implements IWomblexShapeReader {
  async readShape(request: WomblexShapeRequest): Promise<Result<CorpusShape>> {
    const elements: AssetShape = {
      name: "elements",
      present: true,
      readable: true,
      rows: 24,
      columns: [{ name: "kind", type: "string" }],
      values:
        request.documentId === undefined
          ? {}
          : {
              kind: {
                counts: [
                  { value: "paragraph", rows: 15 },
                  { value: "heading", rows: 2 },
                ],
                distinct: 2,
                truncated: false,
              },
            },
      ranges: request.documentId === undefined ? {} : { page: { min: 0, max: 2 } },
    };
    return ok({
      corpusId: request.corpusId,
      runId: request.runId ?? null,
      documentId: request.documentId ?? null,
      documents: 1,
      runs: [
        { runId: "run-throsby-demo", versioned: true, documents: 1, assets: [elements] },
      ],
    });
  }
}

describe("the womblex shape port", () => {
  it("carries no row of document body — only counts and labels", async () => {
    const reader: IWomblexShapeReader = new StubShapeReader();

    const shape = await reader.readShape({ corpusId: "throsby" });

    expect(isOk(shape)).toBe(true);
    if (!isOk(shape)) return;
    expect(JSON.stringify(shape.data)).not.toContain("text");
    expect(shape.data.runs[0]!.assets[0]!.rows).toBe(24);
  });

  it("tallies only at document scope, where the sizing question is asked", async () => {
    const reader: IWomblexShapeReader = new StubShapeReader();

    const run = await reader.readShape({ corpusId: "throsby", runId: "run-throsby-demo" });
    const document = await reader.readShape({
      corpusId: "throsby",
      runId: "run-throsby-demo",
      documentId: "hashA",
    });

    expect(isOk(run) && isOk(document)).toBe(true);
    if (!isOk(run) || !isOk(document)) return;
    expect(run.data.runs[0]!.assets[0]!.values).toEqual({});
    expect(document.data.runs[0]!.assets[0]!.values.kind!.counts[0]).toEqual({
      value: "paragraph",
      rows: 15,
    });
    expect(document.data.runs[0]!.assets[0]!.ranges.page).toEqual({ min: 0, max: 2 });
  });
});
