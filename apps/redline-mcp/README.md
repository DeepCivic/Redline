# @redline/redline-mcp

The **report tool surface**: redline's seven existing read ports, exposed to a
report-assembler LLM as an MCP server over **streamable HTTP**.

This is an **app**, so it is the only place that composes adapters
([`src/lib/container.ts`](./src/lib/container.ts)). It holds no use case — the
tools already existed as ports, and exposure is all this package is.

## The seven tools

| Tool                             | Port method                                   |
| -------------------------------- | --------------------------------------------- |
| `fetch_chunks`                   | `IChunkStore.fetchChunks`                     |
| `fetch_chunks_by_structure`      | `IChunkStore.fetchByStructure`                |
| `fetch_money_spans_by_document`  | `IMoneySpanStore.fetchByDocument`             |
| `fetch_money_spans_by_structure` | `IMoneySpanStore.fetchByStructure`            |
| `read_extraction_elements`       | `IProcurementExtractionReader.readElements`   |
| `read_extraction_chunks`         | `IProcurementExtractionReader.readChunks`     |
| `read_extraction_table_cells`    | `IProcurementExtractionReader.readTableCells` |

Every tool is a pure read of stored rows, scoped to one `evaluationId`, and is
annotated `readOnlyHint` / `idempotentHint`.

## Why this rather than `postgres-mcp`

A generic SQL tool reaches the same rows and drops the contract the ports encode.

- **Stable ordering**, so a report assembled twice is the same report. Chunks come
  back ordered by `(documentId, chunkIndex)`; money spans by a total order across
  all three loci.
- **Verbatim text** — byte-identical, copied into report slots, never paraphrased.
  That byte-identity _is_ the provenance claim the product makes.
- **No embeddings.** `redline_chunks.embedding` sits beside the text, and one
  `SELECT *` at the measured ~90k chunks is a very expensive mistake. The
  projection here is exactly the domain `ChunkRow`, so no vector is ever selected.

`postgres-mcp` remains worth having for ad-hoc analysis, off this path.

## What the tools deliberately do not do

- **No similarity search.** `IChunkStore.findSimilar` refuses with
  `NOT_IMPLEMENTED` until the `pgvector`/ANN index lands, so it is not a tool. The
  enrich graph is off in redline's womblex profile too. Both tools an assembler
  gets are deterministic — exact fetch by key, structural fetch by provenance — so
  it transfers facts it is _pointed at_ rather than roaming the corpus.
- **No interpretation of money.** A financial expression reaches the assembler with
  its magnitude, currency, value type and provenance: an exact decimal `value`, a
  possibly-unresolved `currency`, and the qualifiers womblex refuses to fold in
  (`modifier`, `multiplier`, `negative`, `rangeGroup`/`rangeRole`). Nothing is
  totalled, converted or attached to a requirement. The review grid's
  `readDocumentMoney` is a _separate_ reading of the same rows, and is not the shape
  these tools serve.
- **No writes.** There is no mutation on this surface at all.

Each payload reports `returned` / `available` / `truncated`, so the `MAX_TOOL_ROWS`
cap is visible to the caller rather than looking like the whole answer. The cap
protects the assembler's context, not the store.

## Registering it in Wayfinder

Transport `streamable-http`, url `http://redline-mcp:8930/mcp`, and
**`communicatesExternally: false`**.

That flag classifies whether a server talks _outside Wayfinder_. This one does not:
it reads redline's own Postgres inside the same deployment and sends nothing
anywhere. That it reads commercial-in-confidence tender documents is a
confidentiality concern about the data, not about egress, and it is the case
Wayfinder's `false` branch governs — a self-contained internal utility under the
document human-review gate. Asserting `true` would be a category error with teeth:
an external server is registered but **not selectable in flows**
(`packages/application/src/use-cases/mcp/mcp.ts`), which would make the report
assembler unbuildable.

## Running it

```
podman compose -f infra/docker-compose.yml --profile report up -d
```

Or directly, from this directory:

```
REDLINE_DATABASE_URL=postgres://redline:redline-dev@localhost:5432/redline \
WOMBLEX_INGEST_URL=http://localhost:8000 \
pnpm start
```

| Variable               | Default      | Role                                 |
| ---------------------- | ------------ | ------------------------------------ |
| `REDLINE_DATABASE_URL` | — (required) | The `redline_` store, read-only      |
| `WOMBLEX_INGEST_URL`   | — (required) | The sidecar's Parquet→JSON read seam |
| `REDLINE_MCP_PORT`     | `8930`       | Listen port                          |
| `REDLINE_MCP_HOST`     | `0.0.0.0`    | Listen address                       |
| `REDLINE_MCP_ENDPOINT` | `/mcp`       | The MCP endpoint path                |

`GET /health` answers for an orchestrator; it is not part of the MCP surface.

The server is **stateless** — one transport per request, no session map. The tools
carry no cross-call state, and Wayfinder opens a fresh client per call and closes
it, which is exactly the traffic shape stateless mode is for.
