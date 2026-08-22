# Redline — requirements

Every behaviour Redline is required to have, as Given/When/Then statements, tagged
`[BUILT]` or `[NOT BUILT]`. What is present and what is outstanding is governed by
[`Redline-Status.md`](./Redline-Status.md); this document restates it as testable
statements and adds nothing beyond them. Column names come from
[`Womblex-Output-Contract.md`](./Womblex-Output-Contract.md), never from memory.

---

## 1. Boundary rules

These hold over every statement below.

- **Given** any tool response, **when** it carries a value Womblex wrote, **then**
  that value is byte-identical to what Womblex wrote. `[BUILT]`
- **Given** any request, **when** Redline serves it, **then** no LLM call, no
  summarisation and no inference occurs — an error is returned rather than a
  plausible substitute. `[BUILT]`
- **Given** two identical calls, **when** both are served, **then** identical bytes
  are returned and no state is written. `[BUILT]`
- **Given** a corpus holding several runs, **when** any read is served, **then** it
  is scoped to one named run. `[BUILT]`
- **Given** any payload carrying document body, **when** it is returned, **then** it
  names exactly one document. `[BUILT]`
- **Given** any capped payload, **when** it is returned, **then** it reports
  `returned`, `available` and `truncated`. `[BUILT]`

---

## 2. Sidecar — `services/womblex-ingest` `[BUILT]`

- **Given** a running sidecar, **when** `GET /health` is called, **then** status,
  bucket, mode and whether Isaacus is reachable are returned.
- **Given** a document set, **when** `POST /ingest` is called, **then** extraction
  runs, shards and JSON are written, and a run id is returned.
- **Given** a run id, **when** `GET /status/{run_id}` is called, **then** the run
  state is returned.
- **Given** a corpus with runs, **when** `GET /runs/{corpusId}` is called, **then**
  its runs are returned newest first.
- **Given** a run, **when** `GET /runs/{corpusId}/{runId}/assets` is called, **then**
  the shard families that run holds are listed.
- **Given** a run and an asset, **when**
  `GET /runs/{corpusId}/{runId}/shards/{asset}` is called, **then** rows and schema
  are returned verbatim, honouring `limit`, `offset` and `documentId`.
- **Given** a decimal column, **when** it is serialised, **then** it is emitted as an
  exact digit string and never routed through a float.
- **Given** a run written under either directory spelling, or a document under either
  identity spelling, **when** it is discovered or filtered, **then** both spellings
  resolve.
- **Given** the `embeddings` asset, **when** it is requested, **then** it is refused,
  because Womblex ships no index and nothing can rank those vectors.
- **Given** a document id, **when** `GET /extractions/{corpusId}/{documentId}` is
  called, **then** the older per-document read model answers.

---

## 3. Domain and adapters `[BUILT]`

- **Given** `packages/redline-domain`, **when** it is built, **then** it carries zero
  external dependencies and relative imports only.
- **Given** any port call, **when** it fails, **then** `{ error: DomainError }` is
  returned rather than an exception thrown across the boundary.
- **Given** a corpus, run and asset with an optional document and `limit`/`offset`,
  **when** `IWomblexAssetReader.readShard` is called, **then** a `ShardPage` of
  Womblex's own columns is returned verbatim.
- **Given** a sidecar response, **when** the wire validator inspects it, **then**
  only the page envelope is checked and row contents are trusted verbatim.

---

## 4. MCP server — `apps/redline-mcp`

### Transport `[BUILT]`

- **Given** an MCP request, **when** it is served, **then** transport is streamable
  HTTP, stateless, with one transport per request.
- **Given** a connected client, **when** it lists tools, **then**
  `list_documents`, `read_extraction_elements`, `read_extraction_chunks` and
  `read_extraction_table_cells` are advertised.

### `list_documents` `[BUILT]`

- **Given** a corpus and run, **when** `list_documents` is called, **then** each
  document's manifest columns are returned verbatim at the top level, 25 documents
  per page, with `returned`/`available`/`truncated`.
- **Given** a run where the enrich stage did not run, **when** documents are listed,
  **then** `enrichment` is `null` rather than absent or fabricated.
- **Given** a document with entities, **when** it is listed, **then** up to 20
  `entity_names` are returned under their own key, with their own
  `returned`/`available`/`truncated`.
- **Given** a filter on `status`, `ext`, `doc_type_enriched`, `jurisdiction` or an
  entity name, **when** documents are listed, **then** the set narrows by exact
  match only, never by text search.
- **Given** any `list_documents` payload, **when** it is returned, **then** it
  carries no document body.

### Whole-document shard reads `[BUILT]`

- **Given** a corpus, run and document, **when** `read_extraction_elements`,
  `read_extraction_chunks` or `read_extraction_table_cells` is called, **then** that
  one document's rows are returned verbatim, defaulting to 500 rows with
  `limit`/`offset` passed through and `returned`/`available`/`truncated` reported
  from the sidecar page.

---

## 5. Infrastructure and the gate `[BUILT]`

- **Given** the compose stack, **when** the `ingest` or `report` profile is started,
  **then** MinIO plus the sidecar, or the MCP server, comes up — the Womblex engine
  is not in this stack.
- **Given** a real MinIO, **when** `scripts/ingest-smoke.sh` runs, **then** the
  sidecar is proven end to end.
- **Given** a host with no local Node, **when** `validate.sh` runs, **then** it
  selects the Podman runner and prints which runner it chose.
- **Given** the workspace, **when** `./validate.sh` runs, **then** all 8 checks pass:
  workspace typecheck, lint and test; `redline-domain` purity; no focused tests;
  source file size; sidecar pytest; ruff.

---

## 6. Outstanding

Each section corresponds to an outstanding item in `Redline-Status.md` §4.

### Shape aggregation in the sidecar `[BUILT]`

- **Given** a corpus, **when** its shape is requested, **then** each run is reported
  separately with its document count and per-asset row counts, and runs are never
  merged into one set of counts.
- **Given** a run, **when** its shape is requested, **then** every asset reports
  whether it is present, whether it is readable, its columns and its row count.
- **Given** a document, **when** its shape is requested, **then** per-asset row
  counts for that document are returned along with the declared filter-value
  tallies — `kind` counts and the `page` range on `elements`, and their equivalents
  per asset.
- **Given** any shape read, **when** it runs, **then** no document-body column is
  decoded: row counts come from the Parquet footer and tallies read only the
  declared low-cardinality columns.
- **Given** an entity name, **when** tallies are computed, **then** it is not
  tallied — it is unbounded, and it is content.

### `discover_corpus_shape` `[NOT BUILT]`

- **Given** a corpus, a run or a document, **when** `discover_corpus_shape` is
  called, **then** the matching scope's counts are returned and no payload carries a
  row of document body.
- **Given** counts in the payload, **when** they are returned, **then** they sit
  under their own labelled keys as derived values, while the tallied column values
  themselves are verbatim.
- **Given** two runs of one corpus, **when** the corpus scope is requested, **then**
  each run's counts are reported separately.

### Column filters and a count mode on the read seam `[NOT BUILT]`

- **Given** a filter on a declared column, **when** a shard is read, **then**
  `available` counts the filtered set rather than the whole asset.
- **Given** a count mode, **when** a shard is read, **then** counts are returned
  with zero rows.

### `get_document_elements` `[NOT BUILT]`

- **Given** a document, **when** its elements are requested, **then** they are
  returned 20 at a time in `elem_order`, never unbounded, with
  `returned`/`available`/`truncated` honest at every page and `truncated: false` on
  the last.
- **Given** a page that reaches 20,000 characters before 20 rows, **when** it is
  returned, **then** it is capped by characters and `truncatedBy` says so.
- **Given** a `limit` above the ceiling of 200 rows, **when** it is supplied,
  **then** the ceiling is enforced server-side rather than honoured.
- **Given** one row that exceeds the character budget on its own, **when** it is
  returned, **then** its value is served whole and the payload reports that it
  exceeded budget — a value is never truncated.
- **Given** `page_number`, **when** it is supplied, **then** the set narrows to that
  printed page, independently of the `offset`/`limit` cursor.
- **Given** `element_kinds`, **when** it is supplied, **then** the set narrows on
  Womblex's `kind` column.
- **Given** a non-text kind carrying `text: None`, **when** it is returned, **then**
  the null is served as null and the element is never dropped, so `elem_order` stays
  contiguous — `alt_text` is not folded into `text`, because that would put a
  derived value in an extracted column.
- **Given** a row with null-valued columns, **when** it is returned, **then** those
  keys are omitted while `columns` still declares the full shard schema, and the
  constant `source_hash` is hoisted to the envelope.

### `get_document_entities` `[NOT BUILT]`

- **Given** a document, **when** its entities are requested, **then** `entity_id`,
  `entity_label`, `name`, `entity_type`, `role`, `mention_start`/`mention_end` and
  `chunk_index` are returned verbatim, with the `source_id`/`target_id`/`relation`
  edges between them.
- **Given** an entity whose mention maps to no chunk, **when** it is returned,
  **then** `chunk_index: -1` survives to the caller rather than being filtered away.
- **Given** a run with no enrichment shards, **when** entities are requested,
  **then** the answer says the graph is absent, distinguishably from a graph that
  holds no such entity.

### `get_verbatim_data` `[NOT BUILT]`

- **Given** a document plus an element, chunk or cell reference, **when** it is
  requested, **then** the returned text is byte-identical to the shard's value and
  the resolved anchor is echoed back.
- **Given** an unresolvable reference, **when** it is requested, **then** a
  `NOT_FOUND` error is returned, never an empty string.

### `get_schema` `[NOT BUILT]`

- **Given** a table scope, **when** the schema is requested, **then** that table's
  actual header row is returned as its exact strings, read verbatim from its cells
  and not normalised.
- **Given** a document scope, **when** the schema is requested, **then** the graph
  vocabulary present — entity labels and relation names — is returned.

### The remaining shard reads `[NOT BUILT]`

- **Given** a corpus, **when** `list_runs` is called, **then** its runs are returned
  over the asset-reader port.
- **Given** a document, **when** `read_form_fields`, `read_money_spans`,
  `read_chunks` or `read_table_cells` is called, **then** rows are returned
  paginated and document-scoped, with stable ordering and honest paging.
- **Given** a money span, **when** it is returned, **then** the tool description
  states that `value` already folds in sign and multiplier, and that `multiplier`
  and `negative` are an audit trail rather than arithmetic to redo.

### Retire the per-document read model `[NOT BUILT]`

- **Given** nothing calls it, **when** the per-document read model is retired,
  **then** `GET /extractions/...`, `records.py`'s DTOs, `shard_reader.py`'s mapping
  and `real_extractor.py`'s three-family read are gone and the sidecar suite stays
  green.
- **Given** a tool that needs a currency signal, **when** it returns one, **then**
  the signal sits under a labelled `derived` key above the verbatim rows and is
  never folded in among Womblex's columns.

### A second corpus `[NOT BUILT]`

- **Given** a corpus with two runs, many documents and a populated pricing table,
  **when** the suite runs, **then** the table-cell read, `list_documents` at breadth
  and run scoping are proven together.
