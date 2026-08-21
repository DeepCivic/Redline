// @redline/redline-mcp — the report tool surface.
//
// The run-scoped shard reads (IWomblexAssetReader.readShard), exposed to a
// report-assembler LLM as an MCP server over streamable HTTP.
//
// The process entry is `src/main.ts`; this module is the importable surface, so a
// test or an embedding host can start the same server in-process.

export {
  buildReportTools,
  DEFAULT_TOOL_LIMIT,
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
