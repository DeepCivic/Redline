import { describe, it, expect } from "vitest";
import { isOk, ok } from "@redline/redline-domain";
import type {
  IWomblexAssetReader,
  Result,
  ShardPage,
  ShardRow,
  WomblexAssetRequest,
} from "@redline/redline-domain";
import { buildReportTools } from "./report-tools";
import capture from "./__fixtures__/throsby-navigation-shards.json";

// list_documents against the real throsby run. The rows in the fixture are a
// capture of the sidecar's own shard route over
// services/womblex-ingest/tests/fixtures/run-throsby-demo — a real womblex run's
// Parquet — so a field this tool reads under a name womblex does not write fails
// here rather than surfacing as an empty value in front of a client.

type CapturedAsset = { readonly rows: readonly ShardRow[] };

class CapturedRunReader implements IWomblexAssetReader {
  readonly assetsRead: string[] = [];

  async readShard(request: WomblexAssetRequest): Promise<Result<ShardPage>> {
    this.assetsRead.push(request.asset);
    const asset = (capture as Record<string, CapturedAsset | undefined>)[request.asset];
    const rows = asset?.rows ?? [];
    const offset = request.offset ?? 0;
    const limit = request.limit ?? rows.length;
    const window = limit < 0 ? rows.slice(offset) : rows.slice(offset, offset + limit);
    return ok({
      asset: request.asset,
      runId: request.runId,
      columns: [],
      rows: window,
      returned: window.length,
      available: rows.length,
      truncated: offset + window.length < rows.length,
    });
  }
}

const THROSBY_HASH = "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54";

const listThrosby = async (reader: CapturedRunReader, over: Record<string, unknown> = {}) => {
  const tool = buildReportTools({ assetReader: reader }).find(
    (candidate) => candidate.name === "list_documents",
  )!;
  return tool.call({ corpusId: "throsby", runId: "run-throsby-demo", ...over });
};

describe("list_documents against the real throsby run", () => {
  it("reads no shard carrying document text", async () => {
    const reader = new CapturedRunReader();

    await listThrosby(reader);

    expect(reader.assetsRead.sort()).toEqual(["enrichment_meta", "entities", "manifest"]);
  });

  it("serves the run's document with womblex's own manifest values, verbatim", async () => {
    const reader = new CapturedRunReader();

    const result = await listThrosby(reader);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.returned).toBe(1);
    expect(result.data.available).toBe(1);
    expect(result.data.truncated).toBe(false);
    const [document] = result.data.documents as Record<string, unknown>[];
    expect(document).toMatchObject({
      source_hash: THROSBY_HASH,
      doc_id: "throsby-oosc",
      filename: "throsby-oosc.pdf",
      ext: ".pdf",
      status: "completed",
      elements_count: 24,
      table_cells_count: 0,
      form_fields_count: 2,
    });
  });

  it("carries the enrichment stage's own values under the labelled key, and only those three", async () => {
    const reader = new CapturedRunReader();

    const result = await listThrosby(reader);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [document] = result.data.documents as Record<string, unknown>[];
    expect(document!.enrichment).toEqual({
      title: "Decision to Issue Administrative Action RE: NOT-40822824",
      doc_type_enriched: "other",
      jurisdiction: "AU-VIC",
    });
    // ENRICHMENT_META_SCHEMA's per-label counts are not part of the document list.
    expect(document!.enrichment).not.toHaveProperty("person_count");
    expect(document).not.toHaveProperty("title");
  });

  it("collapses the run's 34 entity rows to their 12 distinct names", async () => {
    const reader = new CapturedRunReader();

    const result = await listThrosby(reader);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [document] = result.data.documents as Record<string, unknown>[];
    const names = document!.entity_names as Record<string, unknown>;
    expect(names.available).toBe(12);
    expect(names.returned).toBe(12);
    // Twelve distinct names sits under the cap, so the real run cannot exercise
    // truncation — report-tools.test.ts stages that against a wider set.
    expect(names.truncated).toBe(false);
    expect(names.names).toContain("ACT Regulatory Authority");
  });

  it("filters on a real entity name, and refuses a substring of one", async () => {
    const matched = await listThrosby(new CapturedRunReader(), {
      entityName: "ACT Regulatory Authority",
    });
    const substring = await listThrosby(new CapturedRunReader(), { entityName: "Regulatory" });

    expect(isOk(matched)).toBe(true);
    expect(isOk(substring)).toBe(true);
    if (!isOk(matched) || !isOk(substring)) return;
    expect(matched.data.available).toBe(1);
    expect(substring.data.available).toBe(0);
  });

  it("filters on the enrichment stage's real jurisdiction value", async () => {
    const result = await listThrosby(new CapturedRunReader(), { jurisdiction: "AU-VIC" });
    const wrong = await listThrosby(new CapturedRunReader(), { jurisdiction: "AU-ACT" });

    expect(isOk(result)).toBe(true);
    expect(isOk(wrong)).toBe(true);
    if (!isOk(result) || !isOk(wrong)) return;
    expect(result.data.available).toBe(1);
    expect(wrong.data.available).toBe(0);
  });
});
