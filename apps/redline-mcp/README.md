# @redline/redline-mcp

Womblex's extraction assets, exposed verbatim to a report-assembler LLM as an MCP
server over **streamable HTTP**. Read-only, stateless, and generating nothing.

This is an **app**, so it is the only place that composes adapters
([`src/lib/container.ts`](./src/lib/container.ts)). It holds no use case — the
tools already existed as a port, and exposure is all this package is.

## The three tools

| Tool                             | Port method                                   |
| --------------------------------- | --------------------------------------------- |
| `read_extraction_elements`       | `IProcurementExtractionReader.readElements`   |
| `read_extraction_chunks`         | `IProcurementExtractionReader.readChunks`     |
| `read_extraction_table_cells`    | `IProcurementExtractionReader.readTableCells` |

Every tool is a pure read of one document's JSON extraction (served by the
`womblex-ingest` sidecar), scoped to one `evaluationId` + `documentId`, and is
annotated `readOnlyHint` / `idempotentHint`.

**This is not the whole surface.** Womblex writes twelve shard families and these
tools reach three of them. `get_schema`, `get_verbatim_data`, `list_runs`,
`list_documents`, form fields, money spans and the three graph tools are
outstanding — see `docs/Redline-Status.md` §3. The sidecar already serves every
family generically (`GET /runs/{corpusId}/{runId}/shards/{asset}`); what is
missing is the port, the adapter and the tools on top of it.

## What these tools guarantee

- **Stable ordering**, so a report assembled twice is the same report.
- **Verbatim text** — byte-identical, copied into report slots, never paraphrased.
  That byte-identity _is_ the provenance claim the product makes.

One caveat, recorded because it is a live defect rather than a design choice:
these three tools serve a **camelCase read model**, not womblex's own column
names, and their `isCurrency` is *derived* from cell text rather than read from a
shard. Both breach the verbatim rule. `docs/Redline-Status.md` §3 item 1 is the
fix.

## What the tools deliberately do not do

- **No similarity search.** Womblex writes `*.embeddings.parquet` and ships no
  index, so nothing ranks those vectors. A client works from ids and anchors it
  was given, or traverses the graph.
- **No writes.** There is no mutation on this surface at all.

Each payload reports `returned` / `available` / `truncated`, so the
`MAX_TOOL_ROWS` cap is visible to the caller rather than looking like the whole
answer. The cap protects the assembler's context, not the store.

## Registering it in Wayfinder

Transport `streamable-http`, url `http://redline-mcp:8930/mcp`, and
**`communicatesExternally: false`**.

That flag classifies whether a server talks _outside Wayfinder_. This one does not:
it reads the `womblex-ingest` sidecar's JSON extraction seam inside the same
deployment and sends nothing anywhere. That it reads commercial-in-confidence
tender documents is a confidentiality concern about the data, not about egress.
Asserting `true` would be a category error with teeth: an external server is
registered but **not selectable in flows**, which would make the report
assembler unbuildable.

## Running it

```
podman compose -f infra/docker-compose.yml --profile report up -d
```

Or directly, from this directory:

```
WOMBLEX_INGEST_URL=http://localhost:8000 \
pnpm start
```

| Variable               | Default      | Role                                 |
| ---------------------- | ------------ | ------------------------------------ |
| `WOMBLEX_INGEST_URL`   | — (required) | The sidecar's Parquet→JSON read seam |
| `REDLINE_MCP_PORT`     | `8930`       | Listen port                          |
| `REDLINE_MCP_HOST`     | `0.0.0.0`    | Listen address                       |
| `REDLINE_MCP_ENDPOINT` | `/mcp`       | The MCP endpoint path                |

`GET /health` answers for an orchestrator; it is not part of the MCP surface.

The server is **stateless** — one transport per request, no session map. The tools
carry no cross-call state, and Wayfinder opens a fresh client per call and closes
it, which is exactly the traffic shape stateless mode is for.
