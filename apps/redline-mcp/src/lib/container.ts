import { WomblexAssetReader } from "@redline/redline-adapters";
import { domainError, err, ok, type Result } from "@redline/redline-domain";
import type { ReportToolDependencies } from "./report-tools";

// The app's wiring (CLAUDE.md: "wiring lives in lib/container.ts"). This process
// composes the read-side adapters and serves them as tools; it holds no use case,
// because exposure is all this package is.
//
// It lives in an app rather than in `redline-adapters` because adapters is a
// library, not a process, and only apps compose adapters.

export interface ServerConfiguration {
  readonly womblexIngestUrl: string;
  readonly port: number;
  readonly host: string;
  readonly endpoint: string;
}

const DEFAULT_PORT = 8930;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_ENDPOINT = "/mcp";

export type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

const required = (environment: ProcessEnvironment, name: string): Result<string> => {
  const value = (environment[name] ?? "").trim();
  if (value === "") {
    return err(domainError("VALIDATION_FAILED", `${name} must be set`));
  }
  return ok(value);
};

const readPort = (environment: ProcessEnvironment): Result<number> => {
  const raw = (environment.REDLINE_MCP_PORT ?? "").trim();
  if (raw === "") return ok(DEFAULT_PORT);

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return err(
      domainError("VALIDATION_FAILED", `REDLINE_MCP_PORT must be a port number, got "${raw}"`),
    );
  }
  return ok(port);
};

export const readServerConfiguration = (
  environment: ProcessEnvironment,
): Result<ServerConfiguration> => {
  const womblexIngestUrl = required(environment, "WOMBLEX_INGEST_URL");
  if (womblexIngestUrl.error) return err(womblexIngestUrl.error);

  const port = readPort(environment);
  if (port.error) return err(port.error);

  return ok({
    womblexIngestUrl: womblexIngestUrl.data,
    port: port.data,
    host: (environment.REDLINE_MCP_HOST ?? "").trim() || DEFAULT_HOST,
    endpoint: (environment.REDLINE_MCP_ENDPOINT ?? "").trim() || DEFAULT_ENDPOINT,
  });
};

export interface ReportToolContainer {
  readonly dependencies: ReportToolDependencies;
}

// The sidecar's run-scoped shard seam. `fetch` is bound here rather than assumed
// inside the adapter, which keeps the adapter testable without a global.
export const buildReportToolContainer = (
  configuration: ServerConfiguration,
): ReportToolContainer => ({
  dependencies: {
    assetReader: new WomblexAssetReader({
      baseUrl: configuration.womblexIngestUrl,
      httpClient: (url) => fetch(url),
    }),
  },
});
