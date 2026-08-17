import { describe, it, expect } from "vitest";
import { isErr, isOk } from "@redline/redline-domain";
import { readServerConfiguration } from "./container";

// The process's one piece of wiring judgement: what it needs from the environment
// before it can serve anything. A missing sidecar URL must fail loudly at boot
// rather than at the first tool call, which is when an assembler would see it.

const environment = (over: Record<string, string | undefined> = {}) => ({
  WOMBLEX_INGEST_URL: "http://womblex-ingest:8000",
  ...over,
});

describe("readServerConfiguration", () => {
  it("reads the sidecar URL and port from the environment", () => {
    const result = readServerConfiguration(environment({ REDLINE_MCP_PORT: "8931" }));

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual({
      womblexIngestUrl: "http://womblex-ingest:8000",
      port: 8931,
      host: "0.0.0.0",
      endpoint: "/mcp",
    });
  });

  it("defaults the port, host and endpoint when they are not set", () => {
    const result = readServerConfiguration(environment());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.port).toBe(8930);
    expect(result.data.host).toBe("0.0.0.0");
    expect(result.data.endpoint).toBe("/mcp");
  });

  it("refuses to start without WOMBLEX_INGEST_URL", () => {
    const result = readServerConfiguration(environment({ WOMBLEX_INGEST_URL: undefined }));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toContain("WOMBLEX_INGEST_URL");
  });

  it("treats a blank value as absent", () => {
    const result = readServerConfiguration(environment({ WOMBLEX_INGEST_URL: "   " }));

    expect(isErr(result)).toBe(true);
  });

  it("refuses a port that is not a number in range", () => {
    const result = readServerConfiguration(environment({ REDLINE_MCP_PORT: "not-a-port" }));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toContain("REDLINE_MCP_PORT");
  });

  it("refuses a port outside the valid range", () => {
    expect(isErr(readServerConfiguration(environment({ REDLINE_MCP_PORT: "0" })))).toBe(true);
    expect(isErr(readServerConfiguration(environment({ REDLINE_MCP_PORT: "70000" })))).toBe(true);
  });
});
