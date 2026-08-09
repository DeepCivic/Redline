# The report tool surface as a service. Built from the repository root, because a
# pnpm workspace member cannot be installed without its workspace:
#   podman build -f apps/redline-mcp/Dockerfile -t redline-mcp .
#
# The workspace is installed WITHOUT the vendored Wayfinder tree. That is not a
# shortcut: `@rbrasier/domain` is an optional dependency of redline-adapters
# (ADR-0012 — the suite is green without Wayfinder), and this process consumes only
# the redline_ store and the sidecar's JSON seam, so nothing it serves needs it.
# `--no-frozen-lockfile` is required for exactly that reason — the committed
# lockfile is resolved WITH the vendor importer present (validate.sh #12), and a
# frozen install would refuse over an importer this image deliberately omits.
#
# It runs from TypeScript through tsx rather than from compiled output: every
# @redline/* package exports `./src/index.ts`, so a compiled entry would still
# resolve its dependencies to TypeScript source. Compiling the whole workspace to
# a runnable dist is a packaging change, not this item's.
FROM docker.io/library/node:22-alpine

RUN corepack enable

WORKDIR /app

# The manifests first, so a dependency-only change is the sole cache miss.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/redline-domain/package.json packages/redline-domain/
COPY packages/redline-shared/package.json packages/redline-shared/
COPY packages/redline-application/package.json packages/redline-application/
COPY packages/redline-adapters/package.json packages/redline-adapters/
COPY apps/redline-mcp/package.json apps/redline-mcp/

RUN pnpm install --no-frozen-lockfile \
      --filter @redline/redline-mcp... \
      --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/redline-domain packages/redline-domain
COPY packages/redline-shared packages/redline-shared
COPY packages/redline-application packages/redline-application
COPY packages/redline-adapters packages/redline-adapters
COPY apps/redline-mcp apps/redline-mcp

ENV NODE_ENV=production
ENV REDLINE_MCP_PORT=8930
EXPOSE 8930

# Wayfinder addresses this server by URL over streamable HTTP; /health is for the
# orchestrator, not for MCP.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${REDLINE_MCP_PORT}/health" >/dev/null || exit 1

WORKDIR /app/apps/redline-mcp
CMD ["pnpm", "start"]
