import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WomblexExtractionReader, type HttpResponse } from "@redline/redline-adapters";
import { startReportMcpHttpServer, type RunningReportMcpHttpServer } from "./mcp-server";
import type { ReportToolDependencies } from "./report-tools";

// The item's exit test, end to end: a real MCP client lists the tools and calls
// them over streamable HTTP against a fake sidecar, and gets back verbatim
// chunk text and provenance — identical results across two consecutive calls.
// The extraction reader is the real WomblexExtractionReader over its own
// injected HTTP seam, so the sidecar's wire contract is exercised without a
// sidecar process.

const EVALUATION_ID = "eval-mcp-1";
const DOCUMENT_ID = "hashA";

// Text chosen to fail a paraphrasing or trimming transfer: leading and trailing
// whitespace, a tab, a non-breaking space and an em dash all have to survive.
const VERBATIM_TEXT = "  The Contractor shall provide\tsupport 24/7 — including public holidays.  ";

let dependencies: ReportToolDependencies;
let server: RunningReportMcpHttpServer;

const extractionPayload = {
  documentId: DOCUMENT_ID,
  elements: [
    { documentId: DOCUMENT_ID, elementOrder: 4, page: 5, text: "Schedule 3 — Pricing" },
    { documentId: DOCUMENT_ID, elementOrder: 5, page: 5, text: "Total contract value" },
  ],
  chunks: [{ chunkId: `${DOCUMENT_ID}:0`, documentId: DOCUMENT_ID, text: VERBATIM_TEXT }],
  tableCells: [
    {
      documentId: DOCUMENT_ID,
      elementOrder: 4,
      page: 5,
      rowIndex: 1,
      columnIndex: 2,
      rawValue: "$1,500.50",
      isCurrency: true,
    },
  ],
};

const extractionHttpClient = async (url: string): Promise<HttpResponse> => ({
  ok: url.includes(DOCUMENT_ID),
  status: url.includes(DOCUMENT_ID) ? 200 : 404,
  json: async () =>
    url.includes(DOCUMENT_ID)
      ? extractionPayload
      : { error: { code: "NOT_FOUND", message: "no such document" } },
});

const connectClient = async (): Promise<Client> => {
  const client = new Client({ name: "redline-exit-test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  return client;
};

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string => {
  const content = result.content as { type: string; text?: string }[] | undefined;
  const first = content?.[0];
  if (!first || typeof first.text !== "string") throw new Error("tool returned no text content");
  return first.text;
};

const payloadOf = (result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>;

beforeAll(async () => {
  dependencies = {
    extractionReader: new WomblexExtractionReader({
      baseUrl: "http://womblex-ingest.invalid",
      httpClient: extractionHttpClient,
    }),
  };

  server = await startReportMcpHttpServer({ port: 0, host: "127.0.0.1", dependencies });
});

afterAll(async () => {
  await server.close();
});

describe("an MCP client over streamable HTTP", () => {
  it("lists the report tools — the extraction-reader reads", async () => {
    const client = await connectClient();

    const listed = await client.listTools();
    await client.close();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "read_extraction_chunks",
      "read_extraction_elements",
      "read_extraction_table_cells",
    ]);
    expect(listed.tools.every((tool) => (tool.description ?? "").length > 0)).toBe(true);
    expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("serves the extraction reader's elements, chunks and table cells", async () => {
    const client = await connectClient();

    const elements = await client.callTool({
      name: "read_extraction_elements",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    const chunks = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    const tableCells = await client.callTool({
      name: "read_extraction_table_cells",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    expect((payloadOf(elements).elements as unknown[]).length).toBe(2);
    expect((payloadOf(chunks).chunks as { text: string }[])[0]!.text).toBe(VERBATIM_TEXT);
    expect((payloadOf(tableCells).tableCells as Record<string, unknown>[])[0]).toMatchObject({
      elementOrder: 4,
      rowIndex: 1,
      columnIndex: 2,
      rawValue: "$1,500.50",
      isCurrency: true,
    });
  });

  it("returns identical results across two consecutive calls", async () => {
    const client = await connectClient();

    const first = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    const second = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    // Byte-identical payloads, so ordering is asserted along with content.
    expect(textOf(first)).toBe(textOf(second));
  });

  it("reports every matching row as available and none truncated at this size", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    const payload = payloadOf(result);
    expect(payload.available).toBe(1);
    expect(payload.truncated).toBe(false);
  });

  it("reports a port failure as a tool error rather than closing the connection", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "read_extraction_elements",
      arguments: { evaluationId: EVALUATION_ID, documentId: "no-such-document" },
    });
    // The same client stays usable — the failure was a tool result, not a transport
    // fault.
    const stillWorks = await client.listTools();
    await client.close();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("NOT_FOUND");
    expect(stillWorks.tools).toHaveLength(3);
  });

  it("rejects a malformed call with a validation error, not a crash", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { evaluationId: EVALUATION_ID },
    });
    await client.close();

    expect(result.isError).toBe(true);
  });

  it("answers a health probe outside the MCP endpoint", async () => {
    const health = await fetch(server.url.replace("/mcp", "/health"));

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });
  });

  // A bound port is how this service actually fails to start under compose, and an
  // unhandled 'error' event would take the process down before main.ts could name
  // the cause. The start must reject so the failure is legible.
  it("rejects when its port is already bound, instead of failing as an uncaught error", async () => {
    const takenPort = Number(new URL(server.url).port);

    await expect(
      startReportMcpHttpServer({ dependencies, port: takenPort, host: "127.0.0.1" }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
