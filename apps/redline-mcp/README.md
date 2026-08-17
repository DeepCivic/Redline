# @redline/redline-mcp

The **report tool surface**: redline's extraction-reader port, exposed to a
report-assembler LLM as an MCP server over **streamable HTTP**.

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

**Seven more tools are coming.** `fetch_chunks`, `fetch_chunks_by_structure`,
both money-span fetches and the three graph tools (`graph_find_entities`,
`graph_edges_from`, `graph_edges_to`) were removed along with the Postgres-backed
ports they read — the store those ports queried no longer exists. They are
rebuilt at build step 4 against the fresh, sidecar-backed contracts step 1
designs. See `docs/Redline-Plan.md` §3.1 for what survived and what step 4
rebuilds.

## Why hand-built tools rather than a generic call over the same rows

The port encodes a contract a raw read does not.

- **Stable ordering**, so a report assembled twice is the same report.
- **Verbatim text** — byte-identical, copied into report slots, never paraphrased.
  That byte-identity _is_ the provenance claim the product makes.

## What the tools deliberately do not do

- **No similarity search.** v1 points at rows — structural fetch by
  document/page/content type — and never discovers them by embedding
  similarity. See `docs/Redline-Plan.md` §1.1.
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
