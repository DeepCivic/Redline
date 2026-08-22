# @redline/redline-mcp

Womblex's extraction assets, exposed verbatim to an MCP client over **streamable
HTTP**. Read-only, stateless, and generating nothing.

This is an **app**, so it is the only place that composes adapters
([`src/lib/container.ts`](./src/lib/container.ts)). It holds no use case — exposure
is all this package is.

## What this surface is for

This surface has to work across a large run, and no payload here may carry verbatim
content from more than one document. Those two together, not convenience, are what
shape every tool: breadth is answered with paging and filters, and the context
window belongs to the client, so this surface must never be the thing that
exhausts it.

The surface separates two jobs and refuses a third:

- **Navigation** — decide *which* documents and *which* passages matter, from
  metadata alone. Counts, names, ids, anchors; no document body.
- **Retrieval** — return the exact bytes for one narrow, named thing, in small
  pages.
- **Accumulation** — holding what has been found so far, across documents. This
  is **the client's**, not Redline's. Redline is stateless: it will not remember
  the previous call, and a tool that appears to accumulate would be lying.

The working shape is a loop, not a bulk read: list documents from metadata, pick
one, ask what it contains, fetch the exact passage, record the finding somewhere
outside Redline, move to the next document. Redline is the catalogue and the
stacks. It is not the notebook.

## Tools today

| Tool | Reads |
| --- | --- |
| `read_extraction_elements` | the `elements` shard |
| `read_extraction_chunks` | the `chunks` shard |
| `read_extraction_table_cells` | the `table_cells` shard |

Each is a pure read of one shard family over the one port (`IWomblexAssetReader`,
served by the `womblex-ingest` sidecar's run-scoped route), scoped to one
`corpusId` + `runId` + `documentId`, annotated `readOnlyHint` / `idempotentHint`,
defaulting to `DEFAULT_TOOL_LIMIT` (500) rows with `limit`/`offset` pass-through,
and reporting `returned` / `available` / `truncated`. Rows come back in Womblex's
own column names, verbatim.

**They are retrieval without navigation.** There is no metadata-only entry point
and no way to ask what a document holds without pulling its rows — so the only way
to find something is to read everything, which is exactly what the context budget
forbids. That is the gap the planned tools close.

## Tools planned

The sidecar already serves every shard family generically, paginated and
document-filterable (`GET /runs/{corpusId}/{runId}/shards/{asset}`), and the port
and adapter now read it. What is missing is the navigation and richer retrieval
tools on top. Full specifications with exit tests are in `docs/Redline-Status.md`
§4.

### Navigation

**`list_documents`** — the entry point, and the only tool designed to be called
against a whole run. Returns metadata for every document and **no document text at
all**: `source_hash`, `doc_id`, `filename`, `ext`, `status` and the manifest's
element / table-cell / form-field counts, plus `title`, `doc_type_enriched` and
`jurisdiction` where the enrich stage ran, plus the distinct **entity names**
Womblex already extracted for each document.

Entity names are what make this navigable rather than merely descriptive: a client
narrows a run to the few documents worth opening by seeing which names appear
where, without opening any of them. They are capped per document with their own count and
truncation flag — 34 entities on one small document means a large run would
otherwise return tens of thousands of strings.

Filtering is exact-match over metadata columns only. **This is not text search.**
Redline cannot rank by relevance and will not pretend to.

**`get_document_entities`** — one document's entities and graph edges, verbatim,
each entity carrying the `chunk_index` it was found in. The graph **locates**; it
never sources. `chunk_index: -1` means the mention maps to no chunk — a real value
meaning "not addressable", which survives to the caller rather than being filtered
away. An absent graph is reported distinctly from an empty one, because "no
enrichment ran" and "no such entity" lead to opposite next actions.

**`get_schema`** — three scopes: an asset's columns and types; **one extracted
table's actual header row**, verbatim from its cells; a document's graph vocabulary.
The table scope is what lets a client define a report column using the words the
document actually uses.

**`list_runs`** — a corpus's runs, newest first. Every other tool needs a run id,
and picking one must be a decision, not a default that drifts between calls.

### Retrieval

**`get_document_elements`** — one document's elements, verbatim, **strictly
paginated**: default 20, never unbounded. Filterable by element kind and by the
document's printed page.

`page_number` and `offset`/`limit` are deliberately separate parameters.
`ELEMENT_SCHEMA` carries a real `page` column — the printed page an element
appeared on, a *filter* — and pagination needs its own cursor. A single `page`
argument would mean the printed page to the caller and the page of results to the
implementation, and the mismatch would be silent.

**`get_verbatim_data`** — exact bytes for one element, chunk or cell, echoing back
the anchor it resolved. This is the end of every navigation path.

**`read_form_fields`, `read_money_spans`, `read_chunks`, `read_table_cells`** —
the remaining shard families, paginated and document-scoped on the same terms.

Money spans carry a caveat their description must state, because getting it wrong
corrupts amounts silently: `value` is exact and **already folds in sign and
multiplier**. `multiplier` and `negative` are an audit trail of how the amount was
read, not arithmetic to redo. `modifier` ("up to", "approximately") is deliberately
*not* folded in, so a bounded amount is not an exact one.

## What every tool guarantees

- **Verbatim text** — byte-identical, safe to copy into a report slot, never
  paraphrased. That byte-identity _is_ the provenance claim.
- **Stable ordering**, so two identical calls are identical and a cap falls in the
  same place both times.
- **Honest paging** — `returned` / `available` / `truncated` on every payload. A
  capped answer that looks complete is worse than an error.
- **An anchor on every row**, so the next call can be narrower than the last.

## What this surface deliberately does not do

- **No generation.** No summarising, no paraphrasing, no inference, no filling a
  gap. An unresolvable reference is a `NOT_FOUND` error, never an empty string a
  caller could read as "exists and is blank".
- **No similarity search.** Womblex writes `*.embeddings.parquet` and ships no
  index, so nothing ranks those vectors. A client works from ids and anchors it was
  given, or traverses the graph.
- **No state.** Nothing is remembered between calls.
- **No writes.** There is no mutation on this surface at all.

## Registering it with a client

Transport `streamable-http`, url `http://redline-mcp:8930/mcp`.

Redline is a long-running service addressed by URL, not a process a client spawns
— it serves no stdio transport. It is stateless, one transport per request, so a
client opening a fresh connection per call and closing it is exactly the traffic
shape this is built for.

Where a client classifies servers by whether they communicate **externally**,
Redline is **internal**: it reads object storage inside its own deployment and
sends nothing anywhere. That it reads commercial-in-confidence documents is a
confidentiality concern about the data, not about egress. Misclassifying it as
external can have real consequences — some hosts register external servers but
make them unselectable — so classify by egress, which is none.

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
