import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isErr } from "@redline/redline-domain";
import { buildReportTools, type ReportTool, type ReportToolDependencies } from "./report-tools";

// The MCP framing around the report tools.
//
// **Transport is constrained, not chosen.** Wayfinder's MCP client speaks SSE and
// streamable-HTTP only — no stdio (`ai-sdk-mcp-client.ts`), and servers are
// URL-addressed — so a stdio server could not be reached from the fork at all.
// This serves streamable HTTP.
//
// **Stateless, one transport per request.** The tools are pure reads with no
// cross-call state, so there is nothing a session would carry. Wayfinder opens a
// fresh client per call and closes it (the AI SDK does not pool), which is exactly
// the traffic shape stateless mode is for, and it removes a class of failure —
// a session map that outlives its client, and 404s after a restart.
//
// **Registration in Wayfinder: `communicatesExternally: false`.** The flag
// classifies whether a server talks *outside Wayfinder*, and this one does not: it
// reads redline's own Postgres inside the same deployment and sends nothing
// anywhere. That it reads commercial-in-confidence tender documents is a
// confidentiality concern about the data, not about egress, and it is exactly the
// case Wayfinder's `false` branch governs — a self-contained internal utility under
// the document human-review gate. Asserting `true` would be a category error with
// teeth: an external server is registered but *not selectable in flows*
// (`mcp.ts`), which would make the report assembler unbuildable.

const SERVER_NAME = "redline-report-tools";
const SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS = [
  "redline's report tool surface: read-only, provenance-addressed access to one",
  "procurement evaluation's extracted text and financial expressions.",
  "",
  "Chunk text is verbatim and safe to transfer into a report slot unchanged — that",
  "byte-identity is the provenance claim the report makes, so never paraphrase a",
  "passage you are quoting. Money spans arrive as womblex wrote them: an exact",
  "decimal `value` that ALREADY carries its magnitude suffix and its sign, so",
  '`multiplier` ("million") and `negative` are an audit trail of how it was read —',
  "never arithmetic to redo. Do not multiply a value by its multiplier or re-apply",
  "its sign. `currency` may be unresolved. The one qualifier womblex refuses to fold",
  'in is `modifier` ("up to", "approximately"), so a bounded amount is not an exact',
  "one; and `rangeGroup`/`rangeRole` link a range's two endpoints, which are two",
  "rows for one amount. Nothing here totals or converts them.",
  "",
  "There is no similarity search on this surface. To find a passage, work from ids",
  "and anchors you were given, or traverse the enrichment graph: graph_find_entities",
  "locates people, places and terms and gives the chunk each was found in, and",
  "graph_edges_from / graph_edges_to follow relations between nodes. The graph",
  "LOCATES source rows; the transfer itself is still an exact fetch_chunks read.",
  "A graph tool that returns graphAvailable: false means no enrichment graph has",
  "been loaded for this evaluation — report that you could not reach it rather than",
  "writing the section anyway, and never mistake an empty match over a loaded graph",
  "for an absent one.",
].join("\n");

const toCallToolResult = async (tool: ReportTool, args: unknown) => {
  const result = await tool.call(args);
  if (isErr(result)) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `${result.error.code}: ${result.error.message}` }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
  };
};

// A fresh McpServer per request in stateless mode; the tools close over the
// injected ports, so building one is cheap allocation and no I/O.
export const createReportMcpServer = (dependencies: ReportToolDependencies): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of buildReportTools(dependencies)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputShape,
        // Every tool is a pure read of stored rows: safe to call, and calling it
        // twice is the same as calling it once.
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      (args: unknown) => toCallToolResult(tool, args),
    );
  }

  return server;
};

export interface ReportMcpHttpServerOptions {
  readonly dependencies: ReportToolDependencies;
  readonly port: number;
  readonly host?: string;
  // The path the MCP endpoint is served on. Wayfinder addresses this server by URL,
  // so the path is part of the contract an admin registers.
  readonly endpoint?: string;
}

export interface RunningReportMcpHttpServer {
  readonly url: string;
  close(): Promise<void>;
}

const respondNotFound = (response: ServerResponse): void => {
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "unknown endpoint" } }));
};

const respondHealthy = (response: ServerResponse): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
};

const handleMcpRequest = async (
  dependencies: ReportToolDependencies,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const server = createReportMcpServer(dependencies);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    // Closing the server closes the transport it owns; both are per-request.
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
};

const respondInfraFailure = (response: ServerResponse, cause: unknown): void => {
  if (response.headersSent) {
    response.end();
    return;
  }
  const message = cause instanceof Error ? cause.message : "unhandled MCP transport failure";
  response.writeHead(500, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code: "INFRA_FAILURE", message } }));
};

export const startReportMcpHttpServer = async (
  options: ReportMcpHttpServerOptions,
): Promise<RunningReportMcpHttpServer> => {
  const endpoint = options.endpoint ?? "/mcp";
  const host = options.host ?? "0.0.0.0";

  const httpServer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://placeholder.invalid").pathname;
    if (path === "/health") return respondHealthy(response);
    if (path !== endpoint) return respondNotFound(response);
    // The transport never throws across this boundary if it can help it; the catch
    // is here so a driver-level failure becomes a 500 rather than an unhandled
    // rejection that takes the process down.
    handleMcpRequest(options.dependencies, request, response).catch((cause: unknown) =>
      respondInfraFailure(response, cause),
    );
    return undefined;
  });

  // `listen` reports failure by emitting 'error', which with no listener attached is
  // an uncaught exception that kills the process before the caller can name the
  // cause. Binding is the one startup step that fails routinely — a port already
  // taken — so it rejects instead, and the listener comes off once bound so runtime
  // faults keep their existing path.
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}${endpoint}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
