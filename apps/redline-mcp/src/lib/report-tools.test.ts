import { describe, it, expect } from "vitest";
import { domainError, err, isErr, isOk, ok } from "@redline/redline-domain";
import type {
  ChunkRow,
  ExtractionChunk,
  ExtractionElement,
  ExtractionTableCell,
  IChunkStore,
  IMoneySpanStore,
  IProcurementExtractionReader,
  MoneySpanFilter,
  MoneySpanRow,
  Result,
  ScoredChunkRef,
  StructureFilter,
} from "@redline/redline-domain";
import { buildReportTools, MAX_TOOL_ROWS, type ReportToolDependencies } from "./report-tools";

// The report tool surface: seven existing read ports, wrapped so a report-assembler
// LLM can call them. The contract the ports encode is the reason this exists rather
// than a generic SQL tool — stable ordering, verbatim text, provenance on every row —
// so these cases assert that contract, not the MCP framing (mcp-server.test.ts does
// that end to end against a real client).

const chunk = (over: Partial<ChunkRow> = {}): ChunkRow => ({
  documentId: "hashA",
  chunkId: "hashA:0",
  chunkIndex: 0,
  contentType: "narrative",
  page: 1,
  text: "The Contractor shall provide 24/7 support.",
  ...over,
});

const span = (over: Partial<MoneySpanRow> = {}): MoneySpanRow => ({
  documentId: "hashA",
  locus: "table_cell",
  textSource: null,
  startChar: null,
  endChar: null,
  page: null,
  elementOrder: null,
  parentElementOrder: 4,
  sheet: null,
  rowIndex: 1,
  columnIndex: 2,
  text: "1500.50",
  value: "1500.5000",
  currency: "AUD",
  currencySource: "column_header",
  evidence: "header+numeric",
  modifier: null,
  multiplier: null,
  negative: false,
  confidence: 0.92,
  rangeGroup: null,
  rangeRole: null,
  columnId: "elem4:col2",
  context: null,
  ...over,
});

class InMemoryChunkStore implements IChunkStore {
  readonly seenFilters: StructureFilter[] = [];

  constructor(private readonly rows: readonly ChunkRow[]) {}

  async fetchChunks(
    evaluationId: string,
    chunkIds: readonly string[],
  ): Promise<Result<readonly ChunkRow[]>> {
    void evaluationId;
    const byId = new Map(this.rows.map((row) => [row.chunkId, row]));
    return ok(
      chunkIds
        .map((chunkId) => byId.get(chunkId))
        .filter((row): row is ChunkRow => row !== undefined),
    );
  }

  async fetchByStructure(
    evaluationId: string,
    filter: StructureFilter,
  ): Promise<Result<readonly ChunkRow[]>> {
    void evaluationId;
    this.seenFilters.push(filter);
    return ok(
      this.rows.filter(
        (row) =>
          (filter.documentId === undefined || row.documentId === filter.documentId) &&
          (filter.contentType === undefined || row.contentType === filter.contentType) &&
          (filter.page === undefined || row.page === filter.page),
      ),
    );
  }

  async findSimilar(): Promise<Result<readonly ScoredChunkRef[]>> {
    return err(domainError("NOT_IMPLEMENTED", "deferred"));
  }
}

class InMemoryMoneySpanStore implements IMoneySpanStore {
  readonly seenFilters: MoneySpanFilter[] = [];

  constructor(private readonly rows: readonly MoneySpanRow[]) {}

  async fetchByDocument(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    void evaluationId;
    return ok(this.rows.filter((row) => row.documentId === documentId));
  }

  async fetchByStructure(
    evaluationId: string,
    filter: MoneySpanFilter,
  ): Promise<Result<readonly MoneySpanRow[]>> {
    void evaluationId;
    this.seenFilters.push(filter);
    return ok(
      this.rows.filter(
        (row) =>
          (filter.documentId === undefined || row.documentId === filter.documentId) &&
          (filter.locus === undefined || row.locus === filter.locus) &&
          (filter.parentElementOrder === undefined ||
            row.parentElementOrder === filter.parentElementOrder) &&
          (filter.currency === undefined || row.currency === filter.currency),
      ),
    );
  }
}

class InMemoryExtractionReader implements IProcurementExtractionReader {
  constructor(
    private readonly elements: readonly ExtractionElement[],
    private readonly chunks: readonly ExtractionChunk[],
    private readonly tableCells: readonly ExtractionTableCell[],
  ) {}

  async readElements(): Promise<Result<readonly ExtractionElement[]>> {
    return ok(this.elements);
  }

  async readChunks(): Promise<Result<readonly ExtractionChunk[]>> {
    return ok(this.chunks);
  }

  async readTableCells(): Promise<Result<readonly ExtractionTableCell[]>> {
    return ok(this.tableCells);
  }
}

class FailingExtractionReader implements IProcurementExtractionReader {
  async readElements(): Promise<Result<readonly ExtractionElement[]>> {
    return err(domainError("NOT_FOUND", "no extraction for that document"));
  }

  async readChunks(): Promise<Result<readonly ExtractionChunk[]>> {
    return err(domainError("NOT_FOUND", "no extraction for that document"));
  }

  async readTableCells(): Promise<Result<readonly ExtractionTableCell[]>> {
    return err(domainError("INFRA_FAILURE", "sidecar unreachable"));
  }
}

const dependencies = (over: Partial<ReportToolDependencies> = {}): ReportToolDependencies => ({
  chunkStore: new InMemoryChunkStore([chunk()]),
  moneySpanStore: new InMemoryMoneySpanStore([span()]),
  extractionReader: new InMemoryExtractionReader([], [], []),
  ...over,
});

const toolNamed = (name: string, over: Partial<ReportToolDependencies> = {}) => {
  const tool = buildReportTools(dependencies(over)).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
};

describe("buildReportTools — the surface itself", () => {
  it("exposes exactly the seven read port methods, each with a description", () => {
    const tools = buildReportTools(dependencies());

    expect(tools.map((tool) => tool.name)).toEqual([
      "fetch_chunks",
      "fetch_chunks_by_structure",
      "fetch_money_spans_by_document",
      "fetch_money_spans_by_structure",
      "read_extraction_elements",
      "read_extraction_chunks",
      "read_extraction_table_cells",
    ]);
    expect(tools.every((tool) => tool.description.length > 0)).toBe(true);
    expect(tools.every((tool) => tool.title.length > 0)).toBe(true);
  });

  it("exposes no similarity search — findSimilar is deferred, so it is not a tool", () => {
    const names = buildReportTools(dependencies()).map((tool) => tool.name);

    expect(names.some((name) => name.includes("similar"))).toBe(false);
  });
});

describe("fetch_chunks — the verbatim transfer mechanic", () => {
  it("returns chunk text byte-identical to the stored row", async () => {
    const stored = chunk({ text: "  Payment terms are 30 days\tnet.  " });
    const tool = toolNamed("fetch_chunks", { chunkStore: new InMemoryChunkStore([stored]) });

    const result = await tool.call({ evaluationId: "eval-1", chunkIds: ["hashA:0"] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const chunks = result.data.chunks as ChunkRow[];
    expect(chunks[0]!.text).toBe(stored.text);
  });

  it("returns rows in the order the caller asked for them", async () => {
    const store = new InMemoryChunkStore([
      chunk({ chunkId: "hashA:0", chunkIndex: 0 }),
      chunk({ chunkId: "hashA:1", chunkIndex: 1 }),
      chunk({ chunkId: "hashA:2", chunkIndex: 2 }),
    ]);
    const tool = toolNamed("fetch_chunks", { chunkStore: store });

    const result = await tool.call({
      evaluationId: "eval-1",
      chunkIds: ["hashA:2", "hashA:0", "hashA:1"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const chunks = result.data.chunks as ChunkRow[];
    expect(chunks.map((row) => row.chunkId)).toEqual(["hashA:2", "hashA:0", "hashA:1"]);
  });

  it("carries provenance on every row — document, index, content type and page", async () => {
    const tool = toolNamed("fetch_chunks");

    const result = await tool.call({ evaluationId: "eval-1", chunkIds: ["hashA:0"] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect((result.data.chunks as ChunkRow[])[0]).toMatchObject({
      documentId: "hashA",
      chunkId: "hashA:0",
      chunkIndex: 0,
      contentType: "narrative",
      page: 1,
    });
  });

  it("never returns an embedding — no vector crosses this surface", async () => {
    const tool = toolNamed("fetch_chunks");

    const result = await tool.call({ evaluationId: "eval-1", chunkIds: ["hashA:0"] });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const [row] = result.data.chunks as Record<string, unknown>[];
    expect(Object.keys(row!)).not.toContain("embedding");
  });

  it("rejects a call with no evaluationId rather than reading across evaluations", async () => {
    const tool = toolNamed("fetch_chunks");

    const result = await tool.call({ chunkIds: ["hashA:0"] });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects an empty chunkIds list — an exact fetch needs keys", async () => {
    const tool = toolNamed("fetch_chunks");

    const result = await tool.call({ evaluationId: "eval-1", chunkIds: [] });

    expect(isErr(result)).toBe(true);
  });
});

describe("fetch_chunks_by_structure — structural addressing", () => {
  it("passes only the fields the caller set through to the port", async () => {
    const store = new InMemoryChunkStore([chunk()]);
    const tool = toolNamed("fetch_chunks_by_structure", { chunkStore: store });

    await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(store.seenFilters[0]).toEqual({ documentId: "hashA" });
  });

  it("narrows on content type and page when both are given", async () => {
    const store = new InMemoryChunkStore([
      chunk({ chunkId: "hashA:0", contentType: "narrative", page: 1 }),
      chunk({ chunkId: "hashA:1", contentType: "table", page: 2 }),
    ]);
    const tool = toolNamed("fetch_chunks_by_structure", { chunkStore: store });

    const result = await tool.call({
      evaluationId: "eval-1",
      documentId: "hashA",
      contentType: "table",
      page: 2,
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect((result.data.chunks as ChunkRow[]).map((row) => row.chunkId)).toEqual(["hashA:1"]);
  });

  it("caps a broad structural read and says so rather than truncating silently", async () => {
    const many = Array.from({ length: MAX_TOOL_ROWS + 5 }, (_unused, index) =>
      chunk({ chunkId: `hashA:${index}`, chunkIndex: index }),
    );
    const tool = toolNamed("fetch_chunks_by_structure", {
      chunkStore: new InMemoryChunkStore(many),
    });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.returned).toBe(MAX_TOOL_ROWS);
    expect(result.data.available).toBe(MAX_TOOL_ROWS + 5);
    expect(result.data.truncated).toBe(true);
  });

  it("reports no truncation when everything fits", async () => {
    const tool = toolNamed("fetch_chunks_by_structure");

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.truncated).toBe(false);
    expect(result.data.returned).toBe(result.data.available);
  });
});

describe("the money-span tools — spans as womblex wrote them", () => {
  it("returns a span uninterpreted: value as an exact string, qualifiers intact", async () => {
    const stored = span({
      value: "2400000.0000",
      modifier: "up to",
      multiplier: "million",
      rangeGroup: 3,
      rangeRole: "upper",
    });
    const tool = toolNamed("fetch_money_spans_by_document", {
      moneySpanStore: new InMemoryMoneySpanStore([stored]),
    });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect((result.data.spans as MoneySpanRow[])[0]).toMatchObject({
      value: "2400000.0000",
      modifier: "up to",
      multiplier: "million",
      rangeGroup: 3,
      rangeRole: "upper",
    });
  });

  it("never converts or totals — two spans come back as two rows, not a sum", async () => {
    const store = new InMemoryMoneySpanStore([
      span({ rowIndex: 1, value: "1000.0000" }),
      span({ rowIndex: 2, value: "2000.0000" }),
    ]);
    const tool = toolNamed("fetch_money_spans_by_document", { moneySpanStore: store });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const spans = result.data.spans as MoneySpanRow[];
    expect(spans.map((row) => row.value)).toEqual(["1000.0000", "2000.0000"]);
    expect(result.data).not.toHaveProperty("estimateAud");
    expect(result.data).not.toHaveProperty("total");
  });

  it("passes a structural money filter through field by field", async () => {
    const store = new InMemoryMoneySpanStore([span()]);
    const tool = toolNamed("fetch_money_spans_by_structure", { moneySpanStore: store });

    await tool.call({
      evaluationId: "eval-1",
      documentId: "hashA",
      locus: "table_cell",
      parentElementOrder: 4,
      currency: "AUD",
    });

    expect(store.seenFilters[0]).toEqual({
      documentId: "hashA",
      locus: "table_cell",
      parentElementOrder: 4,
      currency: "AUD",
    });
  });

  it("refuses a locus womblex does not write", async () => {
    const tool = toolNamed("fetch_money_spans_by_structure");

    const result = await tool.call({ evaluationId: "eval-1", locus: "footnote" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("the extraction-reader tools", () => {
  it("returns elements with their womblex element order and page", async () => {
    const reader = new InMemoryExtractionReader(
      [{ documentId: "hashA", elementOrder: 7, page: 2, text: "Schedule 3 — Pricing" }],
      [],
      [],
    );
    const tool = toolNamed("read_extraction_elements", { extractionReader: reader });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect((result.data.elements as ExtractionElement[])[0]).toMatchObject({
      elementOrder: 7,
      page: 2,
      text: "Schedule 3 — Pricing",
    });
  });

  it("returns extraction chunks keyed on the stable chunk id", async () => {
    const reader = new InMemoryExtractionReader(
      [],
      [{ chunkId: "hashA:4", documentId: "hashA", text: "Warranty period is 36 months." }],
      [],
    );
    const tool = toolNamed("read_extraction_chunks", { extractionReader: reader });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect((result.data.chunks as ExtractionChunk[])[0]!.chunkId).toBe("hashA:4");
  });

  it("returns table cells with their row/column anchor and raw value", async () => {
    const reader = new InMemoryExtractionReader(
      [],
      [],
      [
        {
          documentId: "hashA",
          elementOrder: 4,
          page: 5,
          rowIndex: 2,
          columnIndex: 1,
          rawValue: "$1,500.50",
          isCurrency: true,
        },
      ],
    );
    const tool = toolNamed("read_extraction_table_cells", { extractionReader: reader });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect((result.data.tableCells as ExtractionTableCell[])[0]).toMatchObject({
      elementOrder: 4,
      rowIndex: 2,
      columnIndex: 1,
      rawValue: "$1,500.50",
      isCurrency: true,
    });
  });

  it("propagates a port failure as a DomainError, never as a thrown exception", async () => {
    const tool = toolNamed("read_extraction_elements", {
      extractionReader: new FailingExtractionReader(),
    });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("propagates an infrastructure failure with its own code", async () => {
    const tool = toolNamed("read_extraction_table_cells", {
      extractionReader: new FailingExtractionReader(),
    });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("INFRA_FAILURE");
  });
});

describe("determinism — the reason this is not a generic SQL tool", () => {
  it("gives identical results and ordering across two consecutive calls", async () => {
    const store = new InMemoryChunkStore([
      chunk({ chunkId: "hashA:0", chunkIndex: 0 }),
      chunk({ chunkId: "hashA:1", chunkIndex: 1, contentType: "table" }),
      chunk({ chunkId: "hashB:0", documentId: "hashB", chunkIndex: 0 }),
    ]);
    const tool = toolNamed("fetch_chunks_by_structure", { chunkStore: store });

    const first = await tool.call({ evaluationId: "eval-1" });
    const second = await tool.call({ evaluationId: "eval-1" });

    expect(first).toEqual(second);
  });
});
