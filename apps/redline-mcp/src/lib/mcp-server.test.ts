import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  WomblexAssetReader,
  WomblexShapeReader,
  type HttpResponse,
} from "@redline/redline-adapters";
import { startReportMcpHttpServer, type RunningReportMcpHttpServer } from "./mcp-server";
import type { ReportToolDependencies } from "./report-tools";

// The item's exit test, end to end: a real MCP client lists the tools and calls
// them over streamable HTTP against a fake sidecar, and gets back verbatim
// chunk text and provenance — identical results across two consecutive calls.
// The asset reader is the real WomblexAssetReader over its own injected HTTP
// seam, so the sidecar's wire contract is exercised without a sidecar process.

const CORPUS_ID = "throsby";
const RUN_ID = "run-throsby-demo";
const DOCUMENT_ID = "hashA";

// Text chosen to fail a paraphrasing or trimming transfer: leading and trailing
// whitespace, a tab, a non-breaking space and an em dash all have to survive.
const VERBATIM_TEXT = "  The Contractor shall provide\tsupport 24/7 — including public holidays.  ";

let dependencies: ReportToolDependencies;
let server: RunningReportMcpHttpServer;

// The sidecar's run-scoped shard route serves one page per asset, in womblex's
// own columns. A fake keyed on the asset in the URL stands in for it.
const shardPages: Record<string, unknown> = {
  elements: {
    asset: "elements",
    runId: RUN_ID,
    columns: [
      { name: "source_hash", type: "string" },
      { name: "elem_order", type: "int32" },
      { name: "page", type: "int32" },
      { name: "text", type: "string" },
    ],
    rows: [
      { source_hash: DOCUMENT_ID, elem_order: 4, page: 5, text: "Schedule 3 — Pricing" },
      { source_hash: DOCUMENT_ID, elem_order: 5, page: 5, text: "Total contract value" },
    ],
    returned: 2,
    available: 2,
    truncated: false,
  },
  chunks: {
    asset: "chunks",
    runId: RUN_ID,
    columns: [
      { name: "source_hash", type: "string" },
      { name: "chunk_index", type: "int32" },
      { name: "text", type: "string" },
    ],
    rows: [{ source_hash: DOCUMENT_ID, chunk_index: 0, text: VERBATIM_TEXT }],
    returned: 1,
    available: 1,
    truncated: false,
  },
  table_cells: {
    asset: "table_cells",
    runId: RUN_ID,
    columns: [
      { name: "source_hash", type: "string" },
      { name: "parent_elem_order", type: "int32" },
      { name: "row", type: "int32" },
      { name: "col", type: "int32" },
      { name: "value", type: "string" },
    ],
    rows: [
      { source_hash: DOCUMENT_ID, parent_elem_order: 4, row: 1, col: 2, value: "$1,500.50" },
    ],
    returned: 1,
    available: 1,
    truncated: false,
  },
};

// The sidecar's shape routes. Two runs under one corpus, the older one holding
// extraction only, so the corpus scope has runs of different shape to keep apart.
const elementsShape = (rows: number, tallied: boolean) => ({
  name: "elements",
  present: true,
  readable: true,
  rows,
  columns: [{ name: "kind", type: "string" }],
  values: tallied
    ? {
        kind: {
          counts: [
            { value: "paragraph", rows: 15 },
            { value: "heading", rows: 2 },
          ],
          distinct: 7,
          truncated: false,
        },
      }
    : {},
  ranges: tallied ? { page: { min: 0, max: 2 } } : {},
});

const entitiesShape = (present: boolean) => ({
  name: "entities",
  present,
  readable: true,
  rows: present ? 34 : 0,
  columns: [],
  values: {},
  ranges: {},
});

const shapeBodies: Record<string, unknown> = {
  corpus: {
    corpusId: CORPUS_ID,
    runId: null,
    documentId: null,
    // Null at corpus scope: two runs may hold the same documents, and saying
    // which are the same means reading every run's identity column.
    documents: null,
    runs: [
      {
        runId: RUN_ID,
        versioned: true,
        documents: 1,
        assets: [elementsShape(24, false), entitiesShape(true)],
      },
      {
        runId: "run-20260101T000000Z",
        versioned: true,
        documents: 1,
        assets: [elementsShape(24, false), entitiesShape(false)],
      },
    ],
  },
  run: {
    corpusId: CORPUS_ID,
    runId: RUN_ID,
    documentId: null,
    documents: 1,
    runs: [
      {
        runId: RUN_ID,
        versioned: true,
        documents: 1,
        assets: [elementsShape(24, false), entitiesShape(true)],
      },
    ],
  },
  document: {
    corpusId: CORPUS_ID,
    runId: RUN_ID,
    documentId: DOCUMENT_ID,
    documents: 1,
    runs: [
      {
        runId: RUN_ID,
        versioned: true,
        documents: 1,
        assets: [elementsShape(24, true), entitiesShape(true)],
      },
    ],
  },
};

const shapeScopeFromUrl = (url: string): string => {
  if (url.includes("documentId=")) return "document";
  return /\/runs\/[^/]+\/[^/]+\/shape/.test(url) ? "run" : "corpus";
};

const shapeHttpClient = async (url: string): Promise<HttpResponse> => ({
  ok: true,
  status: 200,
  json: async () => shapeBodies[shapeScopeFromUrl(url)],
});

const assetFromUrl = (url: string): string | null => {
  const match = url.match(/\/shards\/([^?]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
};

const shardHttpClient = async (url: string): Promise<HttpResponse> => {
  const asset = assetFromUrl(url);
  const found = asset !== null && url.includes(DOCUMENT_ID) ? shardPages[asset] : undefined;
  return {
    ok: found !== undefined,
    status: found !== undefined ? 200 : 404,
    json: async () =>
      found ?? { error: { code: "NOT_FOUND", message: "no such document" } },
  };
};

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
    assetReader: new WomblexAssetReader({
      baseUrl: "http://womblex-ingest.invalid",
      httpClient: shardHttpClient,
    }),
    shapeReader: new WomblexShapeReader({
      baseUrl: "http://womblex-ingest.invalid",
      httpClient: shapeHttpClient,
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
      "discover_corpus_shape",
      "list_documents",
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
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID, documentId: DOCUMENT_ID },
    });
    const chunks = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID, documentId: DOCUMENT_ID },
    });
    const tableCells = await client.callTool({
      name: "read_extraction_table_cells",
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    expect((payloadOf(elements).elements as unknown[]).length).toBe(2);
    expect((payloadOf(chunks).chunks as { text: string }[])[0]!.text).toBe(VERBATIM_TEXT);
    expect((payloadOf(tableCells).tableCells as Record<string, unknown>[])[0]).toMatchObject({
      parent_elem_order: 4,
      row: 1,
      col: 2,
      value: "$1,500.50",
    });
  });

  it("returns identical results across two consecutive calls", async () => {
    const client = await connectClient();

    const first = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID, documentId: DOCUMENT_ID },
    });
    const second = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    // Byte-identical payloads, so ordering is asserted along with content.
    expect(textOf(first)).toBe(textOf(second));
  });

  it("reports every matching row as available and none truncated at this size", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID, documentId: DOCUMENT_ID },
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
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID, documentId: "no-such-document" },
    });
    // The same client stays usable — the failure was a tool result, not a transport
    // fault.
    const stillWorks = await client.listTools();
    await client.close();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("NOT_FOUND");
    expect(stillWorks.tools).toHaveLength(5);
  });

  // The shape tool's exit test, over the protocol: three scopes by narrowing, runs
  // kept apart, and not a row of document body in any of them.
  it("sizes a corpus, a run and a document, and keeps the runs apart", async () => {
    const client = await connectClient();

    const corpus = await client.callTool({
      name: "discover_corpus_shape",
      arguments: { corpusId: CORPUS_ID },
    });
    const run = await client.callTool({
      name: "discover_corpus_shape",
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID },
    });
    const document = await client.callTool({
      name: "discover_corpus_shape",
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    const runsOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      payloadOf(result).runs as { runId: string; assets: Record<string, unknown>[] }[];

    expect(runsOf(corpus).map((entry) => entry.runId)).toEqual([
      RUN_ID,
      "run-20260101T000000Z",
    ]);
    expect(runsOf(run)).toHaveLength(1);
    expect(runsOf(run)[0]!.assets[0]!.rows).toBe(24);

    const elements = runsOf(document)[0]!.assets[0] as {
      values: Record<string, { counts: { value: unknown; rows: number }[] }>;
      ranges: Record<string, unknown>;
    };
    expect(elements.values.kind!.counts[0]).toEqual({ value: "paragraph", rows: 15 });
    expect(elements.ranges.page).toEqual({ min: 0, max: 2 });

    // The one property that makes this tool safe to call first: it is metadata,
    // whatever the scope. The fixture's own element text must appear in none of it.
    for (const result of [corpus, run, document]) {
      expect(textOf(result)).not.toContain("Schedule 3");
      expect(textOf(result)).not.toContain(VERBATIM_TEXT.trim());
    }
  });

  it("refuses to size a document without the run that produced it", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "discover_corpus_shape",
      arguments: { corpusId: CORPUS_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("runId");
  });

  it("rejects a malformed call with a validation error, not a crash", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "read_extraction_chunks",
      arguments: { corpusId: CORPUS_ID, runId: RUN_ID },
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

  // The instructions are the only thing a client reads before choosing a tool, so
  // naming one that is not registered sends it looking for a capability that does
  // not exist. This has already happened once: the instructions described money
  // span and graph tools through three scope cuts that removed them.
  it("names no tool in its instructions that it does not register", async () => {
    const client = await connectClient();
    const registered = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const instructions = client.getInstructions() ?? "";
    await client.close();

    const mentioned = instructions.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    const toolLike = mentioned.filter((name) => name.startsWith("read_") || name.startsWith("get_") || name.startsWith("list_") || name.startsWith("fetch_") || name.startsWith("graph_"));

    expect(toolLike.length).toBeGreaterThan(0);
    for (const name of new Set(toolLike)) {
      expect(registered, `instructions name "${name}"`).toContain(name);
    }
  });
});