import { describe, it, expect } from "vitest";
import { domainError, err, isErr, isOk, ok } from "@redline/redline-domain";
import type {
  ExtractionChunk,
  ExtractionElement,
  ExtractionTableCell,
  IProcurementExtractionReader,
  Result,
} from "@redline/redline-domain";
import { buildReportTools, MAX_TOOL_ROWS, type ReportToolDependencies } from "./report-tools";

// The report tool surface: the one surviving read port, wrapped so a
// report-assembler LLM can call it. The contract the port encodes is the reason
// this exists rather than a generic call — stable ordering, verbatim text — so
// these cases assert that contract, not the MCP framing (mcp-server.test.ts does
// that end to end against a real client).

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
  extractionReader: new InMemoryExtractionReader([], [], []),
  ...over,
});

const toolNamed = (name: string, over: Partial<ReportToolDependencies> = {}) => {
  const tool = buildReportTools(dependencies(over)).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool;
};

describe("buildReportTools — the surface itself", () => {
  it("exposes the extraction-reader methods, each with a description", () => {
    const tools = buildReportTools(dependencies());

    expect(tools.map((tool) => tool.name)).toEqual([
      "read_extraction_elements",
      "read_extraction_chunks",
      "read_extraction_table_cells",
    ]);
    expect(tools.every((tool) => tool.description.length > 0)).toBe(true);
    expect(tools.every((tool) => tool.title.length > 0)).toBe(true);
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

  it("returns extraction chunks keyed on the stable chunk id, verbatim", async () => {
    const reader = new InMemoryExtractionReader(
      [],
      [{ chunkId: "hashA:4", documentId: "hashA", text: "  Warranty period is 36 months.  " }],
      [],
    );
    const tool = toolNamed("read_extraction_chunks", { extractionReader: reader });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const chunks = result.data.chunks as ExtractionChunk[];
    expect(chunks[0]!.chunkId).toBe("hashA:4");
    expect(chunks[0]!.text).toBe("  Warranty period is 36 months.  ");
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

  it("caps a broad read and says so rather than truncating silently", async () => {
    const many = Array.from({ length: MAX_TOOL_ROWS + 5 }, (_unused, index) => ({
      chunkId: `hashA:${index}`,
      documentId: "hashA",
      text: `chunk ${index}`,
    }));
    const tool = toolNamed("read_extraction_chunks", {
      extractionReader: new InMemoryExtractionReader([], many, []),
    });

    const result = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.returned).toBe(MAX_TOOL_ROWS);
    expect(result.data.available).toBe(MAX_TOOL_ROWS + 5);
    expect(result.data.truncated).toBe(true);
  });

  it("rejects a call with no evaluationId rather than reading across evaluations", async () => {
    const tool = toolNamed("read_extraction_chunks");

    const result = await tool.call({ documentId: "hashA" });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
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

describe("determinism — the reason this is not a generic read", () => {
  it("gives identical results across two consecutive calls", async () => {
    const reader = new InMemoryExtractionReader(
      [],
      [
        { chunkId: "hashA:0", documentId: "hashA", text: "first" },
        { chunkId: "hashA:1", documentId: "hashA", text: "second" },
      ],
      [],
    );
    const tool = toolNamed("read_extraction_chunks", { extractionReader: reader });

    const first = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });
    const second = await tool.call({ evaluationId: "eval-1", documentId: "hashA" });

    expect(first).toEqual(second);
  });
});
