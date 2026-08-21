# Redline — state of the repo

> **Redline is a read-only MCP server providing verbatim access to Womblex
> extraction assets for provenance-backed report assembly.**

One document: what is actually in this repository today, and what is outstanding.

[`Womblex-Output-Contract.md`](./Womblex-Output-Contract.md) sits beside it and is
not superseded — every Parquet schema Redline reads. Read column names from there,
never from memory.

---

## 1. The boundary

**Womblex** ingests unstructured documents and persists elements, chunks, table
cells, form fields, money spans and graph edges as versioned Parquet assets. It is
the source of truth. It performs no LLM generation and no report assembly.

**Redline** — this repo — serves those assets verbatim over MCP. Headless,
stateless, read-only.

**The client** is whatever calls the MCP endpoint: an LLM assembling a report on a
person's behalf. What it does with what Redline serves, where it keeps its working
state, and how it presents a result are all outside this repository. Redline knows
its client only as a caller of tools.

Womblex reaches Redline through object storage. Redline reaches its client through
one MCP endpoint. **No submodules** — neither neighbour is carried in this tree.

Four rules, non-negotiable, that everything below is measured against:

1. **Verbatim or nothing.** Values are byte-identical to what Womblex wrote.
2. **No generation.** No LLM client, no model call, no inference, no summarisation.
   An error, never a plausible substitute.
3. **No persistence.** No database, no run state, no accumulated result.
4. **Every read is run-scoped.** Runs co-exist under one corpus prefix; a read that
   spans them serves each document once per run and its provenance keys stop
   identifying anything.

---

## 2. The constraint that shapes the tool surface

**The context window is the binding constraint, and Redline is on the wrong side
of it to solve alone.** A corpus is 500 documents. No model holds 500 documents at
once, and Redline must never return 500 documents' worth of verbatim text in one
response. A tool that *could* return the whole corpus is a tool that will, and the
call that does it destroys the session it was meant to serve.

The split that makes 500 documents tractable:

| | Job | Owner |
|---|---|---|
| **Navigation** | Decide *which* documents and *which* passages matter, from metadata alone | **Redline** |
| **Retrieval** | Return the exact bytes for one narrow, named thing | **Redline** |
| **Accumulation** | Hold the facts gathered so far, across documents, so the model need not | **The client** |

Redline is a paginated catalogue and retrieval system. It never summarises, and it
never accumulates. Whatever the client does with a fact once it has it — a
scratchpad, a table, a database — is the client's, and this repository has no
opinion on it beyond refusing to do it.

### What that demands of every tool

- **Metadata-first.** A client must be able to scan the whole landscape without
  reading raw text. Counts, names, ids, statuses — enough to choose, and not one
  byte of document body.
- **Small by default.** Retrieval tools default to a page of tens of rows, not
  hundreds. A caller may ask for more; it may not get everything by accident.
- **Every payload says what it withheld.** `returned`, `available`, `truncated`.
  A capped answer that looks complete is worse than an error.
- **Every row carries its anchor**, so the next call can be narrower than the last.
  Navigation output is only useful if it addresses something.

---

## 3. What is present

### Packages

**`packages/redline-domain`** — ports and primitives. Zero external dependencies,
relative imports only, enforced by `validate.sh` #4 and ESLint.

- `result.ts` — the Result pattern (`{ data } | { error }`), `ok`/`err`/`isOk`/`isErr`
- `errors/domain-error.ts` — the error taxonomy
- `ports/womblex-asset-reader.ts` — `IWomblexAssetReader`, the one port:
  `readShard(request)`, returning a `ShardPage` of Womblex's own columns verbatim
  (`ShardColumn`, `ShardRow`), scoped to one corpus + run + asset with an optional
  document and `limit`/`offset`.

**`packages/redline-adapters`** — one adapter, `WomblexAssetReader`, over the
sidecar's run-scoped shard route (`GET /runs/{corpus}/{run}/shards/{asset}`), with
a hand-rolled wire validator (`wire.ts`) that trusts row *contents* verbatim and
checks only the page envelope. Its fixture (`__fixtures__/shard-pages.json`) is a
real capture of that route against the throsby-demo run.

### Apps

**`apps/redline-mcp`** — the MCP server, streamable HTTP, stateless, one transport
per request. `main.ts` is the process entry; `lib/container.ts` the wiring;
`lib/mcp-server.ts` the framing; `lib/report-tools.ts` the tools.

Three tools are exposed today, all whole-document reads over the one port:

| Tool | Reads |
|---|---|
| `read_extraction_elements` | the `elements` shard |
| `read_extraction_chunks` | the `chunks` shard |
| `read_extraction_table_cells` | the `table_cells` shard |

Each takes `corpusId` + `runId` + `documentId`, serves Womblex's own columns
verbatim, defaults to a page of `DEFAULT_TOOL_LIMIT` (500) rows with `limit`/`offset`
pass-through, and reports `returned` / `available` / `truncated` straight from the
sidecar page. **None of them is navigable**: there is no metadata-only entry point
and no way to ask what a document contains without pulling its rows. §4 item 1 is
that gap.

### Services

**`services/womblex-ingest`** — the Python read sidecar (FastAPI). Reads Womblex's
Parquet from object storage and serves JSON, so Redline's TypeScript never links a
Parquet reader.

| Route | Serves |
|---|---|
| `GET /health` | status, bucket, mode, whether Isaacus is reachable |
| `POST /ingest` | runs extraction, writes shards + JSON, returns a run id |
| `GET /status/{run_id}` | run state |
| `GET /runs/{corpusId}` | the corpus's runs, newest first |
| `GET /runs/{corpusId}/{runId}/assets` | which shard families the run holds |
| `GET /runs/{corpusId}/{runId}/shards/{asset}` | one run's rows + schema, verbatim |
| `GET /extractions/{corpusId}/{documentId}` | the older per-document read model |

`shards.py` is the generic seam: a catalogue of twelve shard families, run
discovery across both directory spellings, document filtering across both identity
spellings, exact decimal serialisation, and `limit`/`offset` paging. `embeddings`
is catalogued and deliberately refused — Womblex ships no index, so nothing can
rank those vectors.

**The paging the tool surface needs already exists here.** The sidecar takes
`limit`, `offset` and `documentId` on every asset. What is missing is above it.

### Infrastructure

`infra/docker-compose.yml` — two profiles: `ingest` (MinIO + sidecar) and `report`
(the MCP server). The Womblex engine is **not** in this stack; it runs from its own
repo and publishes to shared object storage. `infra/womblex/redline.yaml` is the
run profile Redline's reads assume, handed to that externally-run engine.

`scripts/ingest-smoke.sh` proves the sidecar end to end against a real MinIO.
`scripts/podman-run.sh` runs the workspace in a container when the host has no Node.

### Test fixtures

`services/womblex-ingest/tests/fixtures/run-throsby-demo/` is a **real** Womblex
run's shards — one document, an ACT FOI 213A notice. 24 elements, 4 chunks, 2 form
fields, 156 graph edges, 34 entities, 2 money spans. The shard-seam tests read it
directly, so the served column names are checked against real rows rather than
against assumptions the suite and the implementation share.

### The gate

`./validate.sh` — 8 checks: workspace typecheck, lint and test; `redline-domain`
purity; no focused tests; source file size; sidecar pytest; ruff. CI runs the same
gate.

Tests today: 38 TypeScript (2 domain, 10 adapters, 26 MCP) and 116 Python.

---

## 4. Outstanding

Numbered locally; renumbered whenever the set changes. One commit each,
tests-first, with an explicit exit test.

### 1. `list_documents` — the navigation entry point

Metadata for a run's documents, and **no document text at all**. This is what a
client uses to narrow 500 documents to the handful worth opening.

Per document, from `manifest.parquet` unless noted:

| Field | Source |
|---|---|
| `source_hash`, `doc_id`, `filename`, `ext`, `status` | manifest, verbatim |
| `elements_count`, `table_cells_count`, `form_fields_count` | manifest, verbatim |
| `title`, `doc_type_enriched`, `jurisdiction` | `enrichment_meta`, verbatim — absent when the enrich stage did not run |
| `entity_names` | distinct `name` values from `enrichment_entities`, verbatim |
| `chunk_count`, `page_count` | **derived** — a count over `chunks`, a max over `elements.page`. Returned under a labelled `derived` key, never among the manifest columns |

Filtering is exact-match over the metadata columns only — never a text search over
document bodies, which is a capability Redline does not have and must not fake.

`entity_names` is itself an unbounded list: 34 entities for one small document
means a 500-document run could return tens of thousands of strings. It is capped
per document, with its own count and truncation flag, and is filterable.

_Exit: a 500-document run answers in one bounded payload carrying no document text;
`entity_names` truncation is visible per document; derived fields sit under the
labelled key._

### 2. `get_document_elements` — paginated verbatim retrieval

One document's elements, verbatim, **strictly paginated** — default 20, never
unbounded — filterable by element kind and by the document's printed page.

Two parameters are deliberately distinct because Womblex's schema forces it:
`ELEMENT_SCHEMA` has a real `page` column (the printed page the element appeared
on, a *filter*), and pagination needs its own cursor. They are `page_number` and
`offset`/`limit` respectively. Collapsing them into one `page` argument is the
obvious mistake and would silently mean two different things to caller and
implementation.

`element_kinds` filters on Womblex's `kind` column. Note that the non-text kinds
(`table`, `image`, `figure`, `form`, `page_break`, `sheet_meta`, `sheet_cell`)
carry `text: None` and fall back to `alt_text` then `""` — an element with no text
is a real element, not a gap, and is never dropped, because dropping one breaks
`elem_order` contiguity.

_Exit: a document's elements come back 20 at a time, in `elem_order`, with
`returned`/`available`/`truncated` honest at every page; a kind filter and a page
filter each narrow the set; the last page reports `truncated: false`._

### 3. `get_document_entities` — the graph, as navigation

One document's entities and graph edges, verbatim: `entity_id`, `entity_label`,
`name`, `entity_type`, `role`, `mention_start`/`mention_end`, `chunk_index`, and
the `source_id`/`target_id`/`relation` edges between them.

**The graph locates; it never sources.** Every entity carries the `chunk_index` it
was found in, which is the anchor for the next call. `chunk_index` is `-1` when the
mention maps to no chunk — that is a real value meaning "not addressable", not a
missing one, and must survive to the caller rather than being filtered away.

An absent graph and an empty one must be distinguishable: no enrichment stage ran
is a different answer from the graph holding no such entity, and they lead to
opposite next actions.

_Exit: entities and edges answer from the real fixture (34 and 156 rows), each
entity carrying its chunk anchor; a run with no enrichment shards says so rather
than returning empty._

### 4. `get_verbatim_data` — exact bytes for one named thing

Exact bytes for a document plus an element, chunk or cell reference, echoing back
the anchor it resolved. This is the end of every navigation path: the client has
narrowed to one passage and wants precisely it.

_Exit: the returned text is byte-identical to the shard's value for each reference
kind; an unresolvable reference is a `NOT_FOUND` error, never an empty string._

### 5. `get_schema` — dynamic discovery

Three scopes: an asset's columns and types; **one extracted table's actual header
row**, read verbatim from its cells; a document's graph vocabulary (entity labels
and relation names present).

The table scope is the one that matters for defining a report column — it is what
lets a client use the words the document actually uses instead of guessing them.

_Exit: each scope answers against the real fixture corpus; the table scope returns
the header row's exact strings, not a normalised form._

### 6. The remaining shard reads

`list_runs`, `read_form_fields`, `read_money_spans`, `read_chunks` and
`read_table_cells` over the asset-reader port, all paginated and document-scoped on
the same terms as step 2.

Money spans carry a caveat the tool description must state, because getting it
wrong corrupts amounts silently: `value` is exact and **already folds in sign and
multiplier**. `multiplier` and `negative` are an audit trail, not arithmetic to
redo.

_Exit: every tool answers against the fixture corpus, ordering stable, paging
honest._

### 7. Retire the per-document read model

Once nothing calls it: `GET /extractions/...`, `records.py`'s DTOs,
`shard_reader.py`'s mapping and `real_extractor.py`'s three-family read.
`shards.py` supersedes all of it. Note that `derive_is_currency` lives in
`shard_reader.py` and is the derived signal the retired read model relabelled — a
document's currency signal, when a tool needs one, belongs under a labelled
`derived` key above the verbatim rows, never folded in among Womblex's columns.

_Exit: the route and its mapping are gone; the sidecar suite stays green._

### 8. A second corpus

The fixture has **empty** `table_cells` and `money_columns`, two `money_spans` both
narrative locus, one document and one run. So it cannot prove the table-cell or
sheet-cell paths, cannot exercise `list_documents` at any real breadth, and cannot
regress run scoping for real (the current test stages two runs by copying one). A
multi-document corpus with a priced schedule, run twice.

_Exit: a corpus with two runs, many documents and a populated pricing table proves
the table-cell read, `list_documents` at breadth, and run scoping together._

---

## 5. Known gaps and open questions

**`_select_run` is now redundant but still live.** `real_extractor.py` narrows to
one run inside the extractor, which was the partial fix for run scoping. The `/runs/...` routes do it properly. It goes with step 7.

**Nothing checks the Womblex version.** The contract records v0.4.0. A corpus
written by an older engine fails at the first missing column rather than at a
version check.

**Redline does not authenticate.** It assumes deployment isolation. If it is ever
reachable beyond that, these tools read commercial-in-confidence documents with no
caller identity at all.

**What is a `corpusId`, to a client?** Redline takes it on trust and has no way to
validate it beyond "shards exist under that prefix".

**Where does the row cap live?** The sidecar takes `limit`; the MCP tools default
to `DEFAULT_TOOL_LIMIT` (500) and pass `limit`/`offset` through. Whether a client
may raise a retrieval cap, and how high, is unsettled — and it is the one setting
that decides whether a careless call can exhaust a context window.

---

## 6. What Redline is not

Recorded so its absence is not mistaken for missing work and rebuilt. All of it
belongs above Redline, in whatever calls it.

- Report definitions, rows, values, and the state accumulated across documents
- Any database, schema or migration — Redline stores nothing
- Any LLM call, extraction loop, or decision about what a value means
- Column constraints, money and date normalisation, value statuses
- Export in any format
- Any user interface
- Similarity search: Womblex writes embeddings and ships no index, so nothing ranks
  them. Redline points at rows by id, anchor and graph edge, and does not pretend
  to rank

**Two data lessons are kept, because they are about Womblex's output and survive
any change of consumer.**

*Money is already normalised, and re-normalising it corrupts it.* A money span's
`value` is an exact `decimal128(38,4)` with sign and multiplier **already folded
in**. `multiplier` and `negative` are an audit trail, not arithmetic to redo.
`modifier` ("up to") is deliberately not folded in, so a bounded amount is not an
exact one. This is why `shards.py` serialises decimals as digit strings: routing
one through float64 silently rewrites it.

*A parser that guesses is worse than one that refuses.* Stripping everything
outside `[0-9.]` turned `$1.234,56` into `1.23456`, `$1 234,50` into `123450.0`,
`-$500.00` into `500.0` and `($1,234.56)` into `1234.56` — a credit summed as a
debit. Two independent parsers is how that happened. Redline no longer parses money
at all; whoever does, does it once, and refuses ambiguous groupings.
