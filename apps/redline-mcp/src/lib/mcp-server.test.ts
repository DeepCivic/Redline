import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  applyMigrations,
  DrizzleChunkStore,
  DrizzleGraphStore,
  DrizzleMoneySpanStore,
  WomblexExtractionReader,
  redlineSchema,
  type HttpResponse,
} from "@redline/redline-adapters";
import { startReportMcpHttpServer, type RunningReportMcpHttpServer } from "./mcp-server";
import { MAX_TOOL_ROWS, type ReportToolDependencies } from "./report-tools";

// The item's exit test, end to end: a real MCP client lists the tools and calls
// them over streamable HTTP against a populated evaluation, and gets back verbatim
// chunk text and provenance-tagged financial spans — identical results and identical
// ordering across two consecutive calls.
//
// "Populated" is seeded rows in a real Postgres (PGlite, the same migrations that
// ship), not a pipeline run: the store is what the tools read, and how the rows got
// there is not what is under test. The extraction reader is the real
// WomblexExtractionReader over its own injected HTTP seam, so the sidecar's wire
// contract is exercised without a sidecar process.

const EVALUATION_ID = "eval-mcp-1";
const DOCUMENT_ID = "hashA";

// Text chosen to fail a paraphrasing or trimming transfer: leading and trailing
// whitespace, a tab, a non-breaking space and an em dash all have to survive.
const VERBATIM_TEXT = "  The Contractor shall provide\tsupport 24/7 — including public holidays.  ";

let postgres: PGlite;
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

const seedChunks = async (database: ReturnType<typeof drizzle>) => {
  await database.insert(redlineSchema.redlineChunks).values(
    // Inserted out of order on purpose: the store's stable ordering, not the insert
    // order, is what the tools must return.
    [
      {
        evaluationId: EVALUATION_ID,
        chunkId: `${DOCUMENT_ID}:2`,
        sourceHash: DOCUMENT_ID,
        chunkIndex: 2,
        contentType: "table",
        page: 5,
        text: "Item | Price\n1 | 1500.50",
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: "kanon-2-embedder",
      },
      {
        evaluationId: EVALUATION_ID,
        chunkId: `${DOCUMENT_ID}:0`,
        sourceHash: DOCUMENT_ID,
        chunkIndex: 0,
        contentType: "narrative",
        page: 1,
        text: VERBATIM_TEXT,
        embedding: [0.4, 0.5, 0.6],
        embeddingModel: "kanon-2-embedder",
      },
      {
        evaluationId: EVALUATION_ID,
        chunkId: `${DOCUMENT_ID}:1`,
        sourceHash: DOCUMENT_ID,
        chunkIndex: 1,
        contentType: "narrative",
        page: 3,
        text: "Warranty period is 36 months from acceptance.",
      },
    ],
  );
};

const seedMoneySpans = async (database: ReturnType<typeof drizzle>) => {
  const base = {
    evaluationId: EVALUATION_ID,
    documentId: DOCUMENT_ID,
    textSource: null,
    startChar: null,
    endChar: null,
    page: null,
    elementOrder: null,
    sheet: null,
    modifier: null,
    multiplier: null,
    negative: false,
    rangeGroup: null,
    rangeRole: null,
    context: null,
  };
  await database.insert(redlineSchema.redlineMoneySpans).values([
    {
      ...base,
      id: "span-cell-2",
      locus: "table_cell",
      parentElementOrder: 4,
      rowIndex: 2,
      columnIndex: 2,
      text: "800.00",
      value: "800.0000",
      currency: "AUD",
      currencySource: "column_header",
      evidence: "header+numeric",
      confidence: 0.92,
      columnId: "elem4:col2",
    },
    {
      ...base,
      id: "span-cell-1",
      locus: "table_cell",
      parentElementOrder: 4,
      rowIndex: 1,
      columnIndex: 2,
      text: "1500.50",
      value: "1500.5000",
      currency: "AUD",
      currencySource: "column_header",
      evidence: "header+numeric",
      confidence: 0.92,
      columnId: "elem4:col2",
    },
    {
      ...base,
      id: "span-narrative",
      locus: "narrative",
      textSource: "elements",
      startChar: 120,
      endChar: 134,
      page: 3,
      parentElementOrder: null,
      rowIndex: null,
      columnIndex: null,
      text: "up to $2.4 million",
      value: "2400000.0000",
      currency: "AUD",
      currencySource: "symbol",
      evidence: "p3",
      modifier: "up to",
      multiplier: "million",
      confidence: 0.88,
      columnId: null,
    },
  ]);
};

const seedGraph = async (database: ReturnType<typeof drizzle>) => {
  // One person mentioned in chunk 0 (the verbatim narrative chunk), plus the
  // mentioned_in edge that points at it. This is the traversal the assembler runs:
  // entity → edge → chunkId → fetch_chunks → verbatim text.
  await database.insert(redlineSchema.redlineGraphEntities).values([
    {
      evaluationId: EVALUATION_ID,
      documentId: DOCUMENT_ID,
      entityId: `${DOCUMENT_ID}:per:0`,
      entityLabel: "person",
      name: "The Contractor",
      entityType: "corporate",
      role: "seller",
      mentionStart: 2,
      mentionEnd: 16,
      chunkIndex: 0,
    },
  ]);
  await database.insert(redlineSchema.redlineGraphEdges).values([
    {
      evaluationId: EVALUATION_ID,
      documentId: DOCUMENT_ID,
      sourceId: `${DOCUMENT_ID}:per:0`,
      targetId: `${DOCUMENT_ID}:chunk:0`,
      relation: "mentioned_in",
      propKey: "start",
      propValue: "2",
    },
  ]);
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
  postgres = new PGlite();
  const database = drizzle(postgres, { schema: redlineSchema });
  await applyMigrations((sql) => postgres.exec(sql));
  await seedChunks(database);
  await seedMoneySpans(database);
  await seedGraph(database);

  dependencies = {
    chunkStore: new DrizzleChunkStore(database),
    moneySpanStore: new DrizzleMoneySpanStore(database),
    extractionReader: new WomblexExtractionReader({
      baseUrl: "http://womblex-ingest.invalid",
      httpClient: extractionHttpClient,
    }),
    graphStore: new DrizzleGraphStore(database),
  };

  server = await startReportMcpHttpServer({ port: 0, host: "127.0.0.1", dependencies });
});

afterAll(async () => {
  await server.close();
  await postgres.close();
});

describe("an MCP client over streamable HTTP", () => {
  it("lists the report tools — the deterministic reads plus graph traversal", async () => {
    const client = await connectClient();

    const listed = await client.listTools();
    await client.close();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "fetch_chunks",
      "fetch_chunks_by_structure",
      "fetch_money_spans_by_document",
      "fetch_money_spans_by_structure",
      "graph_edges_from",
      "graph_edges_to",
      "graph_find_entities",
      "read_extraction_chunks",
      "read_extraction_elements",
      "read_extraction_table_cells",
    ]);
    expect(listed.tools.every((tool) => (tool.description ?? "").length > 0)).toBe(true);
    expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("gets back chunk text byte-identical to what is stored", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "fetch_chunks",
      arguments: { evaluationId: EVALUATION_ID, chunkIds: [`${DOCUMENT_ID}:0`] },
    });
    await client.close();

    const chunks = payloadOf(result).chunks as { text: string }[];
    expect(chunks[0]!.text).toBe(VERBATIM_TEXT);
  });

  it("never returns an embedding, even though the seeded rows carry one", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "fetch_chunks_by_structure",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    expect(textOf(result)).not.toContain("embedding");
  });

  it("returns provenance-tagged financial spans as womblex wrote them", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "fetch_money_spans_by_document",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    const spans = payloadOf(result).spans as Record<string, unknown>[];
    expect(spans).toHaveLength(3);
    const narrativeSpan = spans.find((span) => span.locus === "narrative");
    expect(narrativeSpan).toMatchObject({
      documentId: DOCUMENT_ID,
      textSource: "elements",
      startChar: 120,
      page: 3,
      value: "2400000.0000",
      currency: "AUD",
      modifier: "up to",
      multiplier: "million",
    });
    // Uninterpreted: no total, no conversion, no requirement attached.
    expect(payloadOf(result)).not.toHaveProperty("estimateAud");
    expect(spans.every((span) => !("requirementId" in span))).toBe(true);
  });

  it("addresses spans structurally by locus and table element", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "fetch_money_spans_by_structure",
      arguments: { evaluationId: EVALUATION_ID, locus: "table_cell", parentElementOrder: 4 },
    });
    await client.close();

    const spans = payloadOf(result).spans as Record<string, unknown>[];
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.locus === "table_cell")).toBe(true);
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

  it("returns identical results and identical ordering across two consecutive calls", async () => {
    const client = await connectClient();

    const firstChunks = await client.callTool({
      name: "fetch_chunks_by_structure",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    const secondChunks = await client.callTool({
      name: "fetch_chunks_by_structure",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    const firstSpans = await client.callTool({
      name: "fetch_money_spans_by_document",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    const secondSpans = await client.callTool({
      name: "fetch_money_spans_by_document",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID },
    });
    await client.close();

    // Byte-identical payloads, so ordering is asserted along with content.
    expect(textOf(firstChunks)).toBe(textOf(secondChunks));
    expect(textOf(firstSpans)).toBe(textOf(secondSpans));
    const chunkIds = (payloadOf(firstChunks).chunks as { chunkId: string }[]).map(
      (chunk) => chunk.chunkId,
    );
    expect(chunkIds).toEqual([`${DOCUMENT_ID}:0`, `${DOCUMENT_ID}:1`, `${DOCUMENT_ID}:2`]);
  });

  it("reports every matching row as available and none truncated at this size", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "fetch_chunks_by_structure",
      arguments: { evaluationId: EVALUATION_ID },
    });
    await client.close();

    const payload = payloadOf(result);
    expect(payload.available).toBe(3);
    expect(payload.truncated).toBe(false);
    expect(payload.returned).toBeLessThanOrEqual(MAX_TOOL_ROWS);
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
    expect(stillWorks.tools).toHaveLength(10);
  });

  it("rejects a malformed call with a validation error, not a crash", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "fetch_chunks",
      arguments: { evaluationId: EVALUATION_ID, chunkIds: [] },
    });
    await client.close();

    expect(result.isError).toBe(true);
  });

  it("traverses entity → edge → chunk to reach verbatim text, and reports the graph available", async () => {
    const client = await connectClient();

    const entities = await client.callTool({
      name: "graph_find_entities",
      arguments: { evaluationId: EVALUATION_ID, documentId: DOCUMENT_ID, entityLabel: "person" },
    });
    const entityRows = payloadOf(entities).entities as { entityId: string; chunkIndex: number }[];
    expect(payloadOf(entities).graphAvailable).toBe(true);
    expect(entityRows[0]!.entityId).toBe(`${DOCUMENT_ID}:per:0`);

    const edges = await client.callTool({
      name: "graph_edges_from",
      arguments: { evaluationId: EVALUATION_ID, entityId: entityRows[0]!.entityId },
    });
    const edgeRows = payloadOf(edges).edges as { targetId: string; relation: string }[];
    const mentionedIn = edgeRows.find((edge) => edge.relation === "mentioned_in");
    expect(mentionedIn!.targetId).toBe(`${DOCUMENT_ID}:chunk:0`);

    // The edge names chunk 0; the chunkId the store keys on is {source_hash}:{index}.
    const chunks = await client.callTool({
      name: "fetch_chunks",
      arguments: { evaluationId: EVALUATION_ID, chunkIds: [`${DOCUMENT_ID}:0`] },
    });
    await client.close();

    const text = (payloadOf(chunks).chunks as { text: string }[])[0]!.text;
    expect(text).toBe(VERBATIM_TEXT);
  });

  it("reports the graph unavailable for an evaluation that has none loaded", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "graph_find_entities",
      arguments: { evaluationId: "eval-with-no-graph", documentId: DOCUMENT_ID },
    });
    await client.close();

    const payload = payloadOf(result);
    expect(payload.graphAvailable).toBe(false);
    expect(payload.entities).toEqual([]);
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
