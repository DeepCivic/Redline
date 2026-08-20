import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isErr } from "@redline/redline-domain";
import { buildReportTools, type ReportTool, type ReportToolDependencies } from "./report-tools";

// The MCP framing around the tools.
//
// **Transport is constrained, not chosen.** This is a long-running service
// addressed by URL, not a process a client spawns, so there is no stdio transport
// here — the clients this serves speak SSE and streamable HTTP only. This serves
// streamable HTTP.
//
// **Stateless, one transport per request.** The tools are pure reads with no
// cross-call state, so there is nothing a session would carry. A client opening a
// fresh connection per call and closing it is exactly the traffic shape stateless
// mode is for, and it removes a class of failure — a session map that outlives its
// client, and 404s after a restart.
//
// **The instructions are load-bearing.** They are the only thing a client reads
// before choosing a tool, so a tool named there but not registered sends it after
// a capability that does not exist. Three scope cuts left this file describing
// money span and graph tools long after they were deleted; `mcp-server.test.ts`
// now fails when the instructions name an unregistered tool.

const SERVER_NAME = "redline-report-tools";
const SERVER_VERSION = "0.1.0";

const SERVER_INSTRUCTIONS = [
  "redline serves one womblex extraction run's assets, verbatim. It is a catalogue",
  "and a retrieval system: it never summarises, never infers, and never remembers a",
  "previous call.",
  "",
  "TEXT IS VERBATIM. Every value is byte-identical to what womblex wrote, including",
  "whitespace and punctuation. That byte-identity is the provenance claim a report",
  "makes, so a passage you quote must be transferred unchanged — never paraphrase,",
  "tidy or re-wrap it. If a value is not here, you get an error, never a substitute.",
  "",
  "MIND THE CONTEXT BUDGET. A corpus holds far more text than you can. Every tool",
  "caps its rows and reports `returned`, `available` and `truncated` — a payload",
  "with truncated: true is a slice, not the answer, and treating it as the answer is",
  "the most expensive mistake available on this surface. Narrow the call instead:",
  "read one document at a time, and keep what you find outside this conversation as",
  "you go, because redline holds no state and will not hand it back to you.",
  "",
  "WHAT IS HERE. read_extraction_elements returns a document's ordered element",
  "stream — the coordinate space every anchor cites. read_extraction_chunks returns",
  "its chunks, keyed on a stable chunk id. read_extraction_table_cells returns its",
  "table cells at their (row, column) anchors. All three are scoped to one document.",
  "",
  "WHAT IS NOT HERE. There is no similarity search and no ranking: womblex writes",
  "embeddings but ships no index, so nothing on this surface can find a passage by",
  "meaning. Work from ids and anchors you were given. There is also no write of any",
  "kind. Asking for either is a mistake about what redline is, not a gap to work",
  "around.",
  "",
  "DERIVED VALUES ARE MARKED. `isCurrency` on a table cell is inferred from the",
  "cell's text — womblex writes no currency column at all. Treat it as a hint about",
  "where to look, never as an extracted fact you can cite.",
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
  // The path the MCP endpoint is served on. Clients address this server by URL, so
  // the path is part of the contract an admin registers.
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
