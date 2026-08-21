import { describe, it, expect } from "vitest";
import { domainError, err, isErr, isOk, ok } from "@redline/redline-domain";
import type {
  IWomblexAssetReader,
  Result,
  ShardPage,
  ShardRow,
  WomblexAssetRequest,
} from "@redline/redline-domain";
import {
  buildReportTools,
  DEFAULT_DOCUMENT_LIMIT,
  DEFAULT_ENTITY_NAME_LIMIT,
  DEFAULT_TOOL_LIMIT,
  type ReportToolDependencies,
} from "./report-tools";

// The report tool surface: the one surviving read port, wrapped so a
// report-assembler LLM can call it. These cases assert the verbatim, run-scoped
// contract — womblex's own columns, honest paging — not the MCP framing
// (mcp-server.test.ts does that end to end against a real client).

// An asset reader with a fixed set of rows per asset, paging them exactly as the
// sidecar would, so the tool's page window is exercised without a sidecar.
class InMemoryAssetReader implements IWomblexAssetReader {
  readonly assetsRead: string[] = [];

  constructor(private readonly rowsByAsset: Readonly<Record<string, readonly ShardRow[]>>) {}

  async readShard(request: WomblexAssetRequest): Promise<Result<ShardPage>> {
    this.assetsRead.push(request.asset);
    const rows = this.rowsByAsset[request.asset] ?? [];
    const offset = request.offset ?? 0;
    const limit = request.limit ?? rows.length;
    // A negative limit serves every matching row, exactly as the sidecar does.
    const window = limit < 0 ? rows.slice(offset) : rows.slice(offset, offset + limit);
    return ok({
      asset: request.asset,
      runId: request.runId,
      columns: [{ name: "source_hash", type: "string" }],
      rows: window,
      returned: window.length,
      available: rows.length,
      truncated: offset + window.length < rows.length,
    });
  }
}

class FailingAssetReader implements IWomblexAssetReader {
  constructor(private readonly error: ReturnType<typeof domainError>) {}
  async readShard(): Promise<Result<ShardPage>> {
    return err(this.error);
  }
}

const dependencies = (over: Partial<ReportToolDependencies> = {}): ReportToolDependencies => ({
  assetReader: new InMemoryAssetReader({}),
  ...over,
});

const toolNamed = (name: string, over: Partial<ReportToolDependencies> = {}) => {
  const tool = buildReportTools(dependencies(over)).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
};

const documentArgs = (over: Record<string, unknown> = {}) => ({
  corpusId: "throsby",
  runId: "run-throsby-demo",
  documentId: "hashA",
  ...over,
});

describe("buildReportTools — the surface itself", () => {
  it("exposes the extraction-reader reads, each with a description", () => {
    const tools = buildReportTools(dependencies());

    expect(tools.map((tool) => tool.name)).toEqual([
      "list_documents",
      "read_extraction_elements",
      "read_extraction_chunks",
      "read_extraction_table_cells",
    ]);
    expect(tools.every((tool) => tool.description.length > 0)).toBe(true);
    expect(tools.every((tool) => tool.title.length > 0)).toBe(true);
  });
});

describe("the extraction-reader tools", () => {
  it("returns rows in womblex's own columns, verbatim", async () => {
    const reader = new InMemoryAssetReader({
      elements: [{ source_hash: "hashA", elem_order: 7, page: 2, text: "Schedule 3 — Pricing" }],
    });
    const tool = toolNamed("read_extraction_elements", { assetReader: reader });

    const result = await tool.call(documentArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.corpusId).toBe("throsby");
    expect(result.data.asset).toBe("elements");
    const rows = result.data.elements as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ elem_order: 7, page: 2, text: "Schedule 3 — Pricing" });
    expect(rows[0]).not.toHaveProperty("elementOrder");
  });

  it("returns chunk text byte-identical, whitespace and all", async () => {
    const reader = new InMemoryAssetReader({
      chunks: [{ source_hash: "hashA", chunk_index: 4, text: "  Warranty period is 36 months.  " }],
    });
    const tool = toolNamed("read_extraction_chunks", { assetReader: reader });

    const result = await tool.call(documentArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const rows = result.data.chunks as Record<string, unknown>[];
    expect(rows[0]!.text).toBe("  Warranty period is 36 months.  ");
  });

  it("returns table cells in womblex's own columns with no invented currency column", async () => {
    const reader = new InMemoryAssetReader({
      table_cells: [{ source_hash: "hashA", parent_elem_order: 4, row: 2, col: 1, value: "$1,500.50" }],
    });
    const tool = toolNamed("read_extraction_table_cells", { assetReader: reader });

    const result = await tool.call(documentArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const rows = result.data.tableCells as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ parent_elem_order: 4, row: 2, col: 1, value: "$1,500.50" });
    expect(rows[0]).not.toHaveProperty("isCurrency");
  });

  it("defaults to a bounded page and reports what it left behind", async () => {
    const many = Array.from({ length: DEFAULT_TOOL_LIMIT + 5 }, (_unused, index) => ({
      source_hash: "hashA",
      chunk_index: index,
      text: `chunk ${index}`,
    }));
    const tool = toolNamed("read_extraction_chunks", {
      assetReader: new InMemoryAssetReader({ chunks: many }),
    });

    const result = await tool.call(documentArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.returned).toBe(DEFAULT_TOOL_LIMIT);
    expect(result.data.available).toBe(DEFAULT_TOOL_LIMIT + 5);
    expect(result.data.truncated).toBe(true);
  });

  it("pages: an offset continues where the previous page stopped", async () => {
    const rows = Array.from({ length: 3 }, (_unused, index) => ({
      source_hash: "hashA",
      chunk_index: index,
      text: `chunk ${index}`,
    }));
    const tool = toolNamed("read_extraction_chunks", {
      assetReader: new InMemoryAssetReader({ chunks: rows }),
    });

    const result = await tool.call(documentArgs({ limit: 2, offset: 2 }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.returned).toBe(1);
    expect(result.data.truncated).toBe(false);
    expect((result.data.chunks as Record<string, unknown>[])[0]!.chunk_index).toBe(2);
  });

  it("rejects a call with no corpusId rather than reading across corpora", async () => {
    const tool = toolNamed("read_extraction_chunks");

    const result = await tool.call({ runId: "run-1", documentId: "hashA" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a call with no runId, since runs co-exist under a corpus", async () => {
    const tool = toolNamed("read_extraction_chunks");

    const result = await tool.call({ corpusId: "throsby", documentId: "hashA" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("propagates a port failure as a DomainError, never as a thrown exception", async () => {
    const tool = toolNamed("read_extraction_elements", {
      assetReader: new FailingAssetReader(domainError("NOT_FOUND", "no such run")),
    });

    const result = await tool.call(documentArgs());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("propagates an infrastructure failure with its own code", async () => {
    const tool = toolNamed("read_extraction_table_cells", {
      assetReader: new FailingAssetReader(domainError("INFRA_FAILURE", "sidecar unreachable")),
    });

    const result = await tool.call(documentArgs());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });
});

describe("determinism — the reason this is not a generic read", () => {
  it("gives identical results across two consecutive calls", async () => {
    const reader = new InMemoryAssetReader({
      chunks: [
        { source_hash: "hashA", chunk_index: 0, text: "first" },
        { source_hash: "hashA", chunk_index: 1, text: "second" },
      ],
    });
    const tool = toolNamed("read_extraction_chunks", { assetReader: reader });

    const first = await tool.call(documentArgs());
    const second = await tool.call(documentArgs());

    expect(first).toEqual(second);
  });
});

// list_documents — the navigation entry point. The one tool called against a whole
// run, and the one that must never touch a shard carrying document body.

const manifestRow = (over: Record<string, unknown> = {}): ShardRow => ({
  source_hash: "hashA",
  doc_id: "DOC-1",
  filename: "throsby-oosc.pdf",
  ext: ".pdf",
  status: "ok",
  elements_count: 24,
  table_cells_count: 0,
  form_fields_count: 2,
  ...over,
});

const listArgs = (over: Record<string, unknown> = {}) => ({
  corpusId: "throsby",
  runId: "run-throsby-demo",
  ...over,
});

const documentsIn = (payload: Record<string, unknown>) =>
  payload.documents as Record<string, unknown>[];

describe("list_documents — navigation", () => {
  it("reads only the shards that carry no document text", async () => {
    const reader = new InMemoryAssetReader({ manifest: [manifestRow()] });
    const tool = toolNamed("list_documents", { assetReader: reader });

    await tool.call(listArgs());

    expect(reader.assetsRead.sort()).toEqual(["enrichment_meta", "entities", "manifest"]);
    expect(reader.assetsRead).not.toContain("elements");
    expect(reader.assetsRead).not.toContain("chunks");
  });

  it("carries the manifest's own columns verbatim at the top level", async () => {
    const reader = new InMemoryAssetReader({ manifest: [manifestRow()] });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [document] = documentsIn(result.data);
    expect(document).toMatchObject({
      source_hash: "hashA",
      doc_id: "DOC-1",
      filename: "throsby-oosc.pdf",
      ext: ".pdf",
      status: "ok",
      elements_count: 24,
      table_cells_count: 0,
      form_fields_count: 2,
    });
    expect(document).not.toHaveProperty("documentId");
    expect(document).not.toHaveProperty("elementsCount");
  });

  it("puts enrichment under its own key, never among the manifest columns", async () => {
    const reader = new InMemoryAssetReader({
      manifest: [manifestRow()],
      enrichment_meta: [
        {
          document_id: "hashA",
          title: "Notice under s 213A",
          doc_type_enriched: "decision",
          jurisdiction: "ACT",
          person_count: 3,
        },
      ],
    });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [document] = documentsIn(result.data);
    expect(document!.enrichment).toEqual({
      title: "Notice under s 213A",
      doc_type_enriched: "decision",
      jurisdiction: "ACT",
    });
    expect(document).not.toHaveProperty("title");
    expect(document).not.toHaveProperty("jurisdiction");
  });

  it("reports enrichment as null when the enrich stage did not run, not as empty fields", async () => {
    const reader = new InMemoryAssetReader({ manifest: [manifestRow()] });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [document] = documentsIn(result.data);
    expect(document!.enrichment).toBeNull();
  });

  it("caps entity names per document and says what it withheld", async () => {
    const entities = Array.from({ length: 34 }, (_unused, index) => ({
      document_id: "hashA",
      entity_id: `e${index}`,
      name: `Entity ${index}`,
    }));
    const reader = new InMemoryAssetReader({ manifest: [manifestRow()], entities });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [document] = documentsIn(result.data);
    const names = document!.entity_names as Record<string, unknown>;
    expect((names.names as string[]).length).toBe(DEFAULT_ENTITY_NAME_LIMIT);
    expect(names.returned).toBe(DEFAULT_ENTITY_NAME_LIMIT);
    expect(names.available).toBe(34);
    expect(names.truncated).toBe(true);
  });

  it("counts an entity name once however many times it is mentioned", async () => {
    const reader = new InMemoryAssetReader({
      manifest: [manifestRow()],
      entities: [
        { document_id: "hashA", entity_id: "e1", name: "Throsby" },
        { document_id: "hashA", entity_id: "e2", name: "Throsby" },
        { document_id: "hashA", entity_id: "e3", name: "ACT Government" },
      ],
    });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const names = documentsIn(result.data)[0]!.entity_names as Record<string, unknown>;
    expect(names.names).toEqual(["Throsby", "ACT Government"]);
    expect(names.available).toBe(2);
    expect(names.truncated).toBe(false);
  });

  it("joins a graph shard spelling its identity document_id to a manifest keyed on source_hash", async () => {
    const reader = new InMemoryAssetReader({
      manifest: [manifestRow({ source_hash: "hashA" }), manifestRow({ source_hash: "hashB" })],
      entities: [{ document_id: "hashB", entity_id: "e1", name: "Only B" }],
    });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [first, second] = documentsIn(result.data);
    expect((first!.entity_names as Record<string, unknown>).names).toEqual([]);
    expect((second!.entity_names as Record<string, unknown>).names).toEqual(["Only B"]);
  });

  it("defaults to a bounded page of documents and reports what it left behind", async () => {
    const many = Array.from({ length: DEFAULT_DOCUMENT_LIMIT + 5 }, (_unused, index) =>
      manifestRow({ source_hash: `hash${index}` }),
    );
    const tool = toolNamed("list_documents", {
      assetReader: new InMemoryAssetReader({ manifest: many }),
    });

    const result = await tool.call(listArgs());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.returned).toBe(DEFAULT_DOCUMENT_LIMIT);
    expect(result.data.available).toBe(DEFAULT_DOCUMENT_LIMIT + 5);
    expect(result.data.truncated).toBe(true);
  });

  it("pages: an offset continues where the previous page stopped", async () => {
    const many = Array.from({ length: 3 }, (_unused, index) =>
      manifestRow({ source_hash: `hash${index}` }),
    );
    const tool = toolNamed("list_documents", {
      assetReader: new InMemoryAssetReader({ manifest: many }),
    });

    const result = await tool.call(listArgs({ limit: 2, offset: 2 }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.returned).toBe(1);
    expect(result.data.truncated).toBe(false);
    expect(documentsIn(result.data)[0]!.source_hash).toBe("hash2");
  });

  it("filters on a manifest column by exact match", async () => {
    const reader = new InMemoryAssetReader({
      manifest: [
        manifestRow({ source_hash: "hashA", status: "ok" }),
        manifestRow({ source_hash: "hashB", status: "failed" }),
      ],
    });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs({ status: "failed" }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.available).toBe(1);
    expect(documentsIn(result.data)[0]!.source_hash).toBe("hashB");
  });

  it("filters on an enrichment column, which lives outside the manifest", async () => {
    const reader = new InMemoryAssetReader({
      manifest: [manifestRow({ source_hash: "hashA" }), manifestRow({ source_hash: "hashB" })],
      enrichment_meta: [
        { document_id: "hashA", title: "A", doc_type_enriched: "contract", jurisdiction: "NSW" },
        { document_id: "hashB", title: "B", doc_type_enriched: "decision", jurisdiction: "ACT" },
      ],
    });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs({ jurisdiction: "ACT" }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.available).toBe(1);
    expect(documentsIn(result.data)[0]!.source_hash).toBe("hashB");
  });

  it("matches an entity name past the cap, so a capped list never hides a document", async () => {
    const entities = Array.from({ length: 34 }, (_unused, index) => ({
      document_id: "hashA",
      entity_id: `e${index}`,
      name: `Entity ${index}`,
    }));
    const reader = new InMemoryAssetReader({ manifest: [manifestRow()], entities });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs({ entityName: "Entity 33" }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.available).toBe(1);
    const names = documentsIn(result.data)[0]!.entity_names as Record<string, unknown>;
    expect(names.names).not.toContain("Entity 33");
    expect(names.available).toBe(34);
  });

  it("matches an entity name exactly — this is not a text search", async () => {
    const reader = new InMemoryAssetReader({
      manifest: [manifestRow()],
      entities: [{ document_id: "hashA", entity_id: "e1", name: "ACT Government" }],
    });
    const tool = toolNamed("list_documents", { assetReader: reader });

    const result = await tool.call(listArgs({ entityName: "Government" }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.available).toBe(0);
  });

  it("rejects a call with no runId, since runs co-exist under a corpus", async () => {
    const tool = toolNamed("list_documents");

    const result = await tool.call({ corpusId: "throsby" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("propagates a port failure as a DomainError, never as a thrown exception", async () => {
    const tool = toolNamed("list_documents", {
      assetReader: new FailingAssetReader(domainError("NOT_FOUND", "no such run")),
    });

    const result = await tool.call(listArgs());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});
