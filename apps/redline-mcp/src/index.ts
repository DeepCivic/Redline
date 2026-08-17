// @redline/redline-mcp — the report tool surface.
//
// IProcurementExtractionReader.readElements / readChunks / readTableCells,
// exposed to a report-assembler LLM as an MCP server over streamable HTTP.
//
// The process entry is `src/main.ts`; this module is the importable surface, so a
// test or an embedding host can start the same server in-process.

export {
  buildReportTools,
  MAX_TOOL_ROWS,
  type ReportTool,
  type ReportToolDependencies,
  type ReportToolPayload,
} from "./lib/report-tools";
export {
  createReportMcpServer,
  startReportMcpHttpServer,
  type ReportMcpHttpServerOptions,
  type RunningReportMcpHttpServer,
} from "./lib/mcp-server";
export {
  buildReportToolContainer,
  readServerConfiguration,
  type ProcessEnvironment,
  type ReportToolContainer,
  type ServerConfiguration,
} from "./lib/container";
