import { isErr } from "@redline/redline-domain";
import { buildReportToolContainer, readServerConfiguration } from "./lib/container";
import { startReportMcpHttpServer } from "./lib/mcp-server";

// The process entry. Reads its configuration, refuses to start without it, and
// serves the report tools over streamable HTTP until it is signalled.

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

const main = async (): Promise<number> => {
  const configuration = readServerConfiguration(process.env);
  if (isErr(configuration)) {
    console.error(`redline-mcp: ${configuration.error.message}`);
    return 1;
  }

  const container = buildReportToolContainer(configuration.data);
  const server = await startReportMcpHttpServer({
    dependencies: container.dependencies,
    port: configuration.data.port,
    host: configuration.data.host,
    endpoint: configuration.data.endpoint,
  });
  console.log(`redline-mcp: report tools on ${server.url}`);

  await new Promise<void>((resolve) => {
    for (const signal of shutdownSignals) {
      process.once(signal, () => resolve());
    }
  });

  await server.close();
  await container.database.$client.end();
  return 0;
};

process.exitCode = await main();
