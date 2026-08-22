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

**Redline serves a whole corpus; a payload serves one document.** Both halves are
requirements, and they are different in kind.

*Redline must work across a large corpus.* A run holds however many documents it
holds, and navigation has to stay usable across all of them — that is met with
paging, filtering and metadata-only answers, never by refusing breadth. A tool that
only works on a small run has not met the requirement.

*No payload carries verbatim content from more than one document.* Retrieval names
exactly one document and returns that document's rows. No page size, filter or
convenience argument turns one call into a copy of two documents' text. Breadth and
body never appear in the same answer.

The second is what keeps the first from destroying the session it was meant to
serve: the context window belongs to the client, and Redline's job is never to be
the thing that exhausts it.

The split that rests on both:

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

- **One document's content per payload.** A tool that returns document body names
  the one document it belongs to. Breadth and body never appear in the same answer.
- **Bounded at any run size.** A run-wide read stays paged and bounded however many
  documents the run holds, and says what it withheld. Scale is answered with paging
  and filters, not by narrowing what a client is allowed to see.
- **Metadata-first.** A client must be able to scan the whole landscape without
  reading raw text. Counts, names, ids, statuses — enough to choose, and not one
  byte of document body.
- **Small by default, and bounded two ways.** A row is not a unit of cost: measured
  against the committed captures, a row runs 240 bytes (`entities`) to ~1,500
  (`chunks`), so one row count bounds a payload by a factor of six either way.
  Retrieval is therefore capped by **rows and by characters, whichever binds
  first** — 20 rows / 20,000 characters by default, 200 / 80,000 as the ceiling a
  caller may raise `limit` to. The ceiling is enforced server-side: `limit` is a
  request, not a command.
- **A cap that binds is a navigation failure.** The caps are a backstop for a
  careless call, not the operating point. A client sizes its read with
  `discover_corpus_shape` and narrows with filters; on the real fixture every
  filtered element read returns 5–15 rows, well inside the default. If truncation
  is routine, the answer is a missing filter or an unmade shape call, not a
  higher limit.
- **Sizing is the client's call.** How much context a read may spend depends on
  the client's remaining window and whether it is reading one document or twenty.
  Redline cannot know either, so it reports size and lets the caller choose,
  rather than guessing on the caller's behalf with a default.
- **Every payload says what it withheld.** `returned`, `available`, `truncated`,
  and `truncatedBy` — `rows` or `characters`. A capped answer that looks complete
  is worse than an error, and a client that knows *which* cap bound learns to
  filter rather than page.
- **A value is never truncated to meet a budget.** One oversized row is served
  whole and the payload reports that it exceeded budget. Verbatim outranks the
  cap; a silently clipped string is the one failure worse than a large payload.
- **Every row carries its anchor**, so the next call can be narrower than the last.
  Navigation output is only useful if it addresses something.
- **No payload pays for columns it did not answer with.** A row omits its
  null-valued keys — `columns` still declares the full shard schema, so absence is
  unambiguously null — and a document-scoped read hoists the constant
  `source_hash` to the envelope. On the real elements capture those two together
  are 32% of the bytes, and `text` is only 30%. Selection is not transformation;
  no value changes.

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
sidecar page.

**`list_documents`** is the navigation entry point above them, and the only tool
called against a whole run rather than one document. It reads `manifest`,
`enrichment_meta` and `entities` — the three shards carrying no document body —
and returns each document's manifest columns verbatim at the top level, with
`enrichment` (`null` where the enrich stage did not run) and a capped
`entity_names` under their own labelled keys. It pages in documents
(`DEFAULT_DOCUMENT_LIMIT`, 25) and caps names per document
(`DEFAULT_ENTITY_NAME_LIMIT`, 20), each reporting its own
`returned` / `available` / `truncated`. Filtering is exact match over `status`,
`ext`, `doc_type_enriched`, `jurisdiction` and an entity name — never a text
search.

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
| `GET /runs/{corpusId}/shape` | every run's size, from Parquet footers alone |
| `GET /runs/{corpusId}/{runId}/shape` | one run's size, or one document's shape (`?documentId=`) |
| `GET /extractions/{corpusId}/{documentId}` | the older per-document read model |

`shards.py` is the generic seam: a catalogue of twelve shard families, run
discovery across both directory spellings, document filtering across both identity
spellings, exact decimal serialisation, and `limit`/`offset` paging. `embeddings`
is catalogued and deliberately refused — Womblex ships no index, so nothing can
rank those vectors.

`shape.py` answers how big a thing is without reading it. Counts come from the
Parquet footer (`read_metadata`), so a corpus- or run-scope answer decodes no rows
at all; a document-scoped count or tally projects the identity column and the
declared low-cardinality labels (`read_table(columns=[...])`) and never a column
carrying text. Tallies are document-scope only — a tally over a whole run scales
with the run, and the sizing question is always asked of one document. Two tests
guard the cost, not just the answer: a run scope must call `read_table` zero
times, and a document scope must project on every call and never name a body
column. Everything it returns is derived, and is labelled as such.

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

`apps/redline-mcp/src/lib/__fixtures__/throsby-navigation-shards.json` is a capture
of the sidecar's shard route over that run's `manifest`, `enrichment_meta` and
`entities`, so `list_documents` is tested against real rows without a live sidecar.
It records something the row counts hide: those 34 entity rows carry **12 distinct
names**, so the real run sits under the name cap and cannot exercise truncation.

`services/womblex-ingest/tests/fixtures/run-throsby-demo/` is a **real** Womblex
run's shards — one document, an ACT FOI 213A notice. 24 elements, 4 chunks, 2 form
fields, 156 graph edges, 34 entities, 2 money spans. The shard-seam tests read it
directly, so the served column names are checked against real rows rather than
against assumptions the suite and the implementation share.

### The gate

`./validate.sh` — 8 checks: workspace typecheck, lint and test; `redline-domain`
purity; no focused tests; source file size; sidecar pytest; ruff. CI runs the same
gate.

Tests today: 61 TypeScript (2 domain, 10 adapters, 49 MCP) and 135 Python.

---

## 4. Outstanding

Numbered locally; renumbered whenever the set changes. One commit each,
tests-first, with an explicit exit test.

The order below is deliberate: shape discovery comes first because every read
after it is smaller and safer once a client can size a call before making it.

### 1. `discover_corpus_shape` — the tool over it

The MCP surface for the sidecar's shape read, and the call a client is told to make first. Three
levels of narrowing: corpus (which runs exist, how big each is), run (per-asset
row counts and columns), document (per-asset row counts plus the filter-value
tallies that make the next retrieval single-shot).

Counts are derived, so they sit under their own labelled keys and are never
presented as extracted columns; the tallied *values* are verbatim column values.
Runs are never merged — a corpus-scope answer reports each run separately, or its
provenance keys stop identifying anything.

This absorbs `get_schema`'s asset-columns scope: "what columns does this asset
have" and "how big is it" are one question.

_Exit: a protocol-level call answers all three scopes against the fixture corpus;
the corpus scope lists two staged runs separately; no payload carries a row of
document body._

### 2. Column filters and a count mode on the read seam

`read_shard` gains exact-match filters on declared columns and a count mode
(`limit: 0` already returns `available` with no rows — this makes it addressable).
Sidecar-side, so the tools above it can filter and still page honestly: a filter
applied above the seam makes `available` count the wrong set.

_Exit: a filtered read reports `available` against the filtered set, not the
whole asset; a count mode returns counts with zero rows._

### 3. `get_document_elements` — paginated verbatim retrieval

One document's elements, verbatim, **strictly paginated** — default 20 rows /
20,000 characters, ceiling 200 / 80,000 — filterable by element kind and by the
document's printed page, over the seam filters from step 2.

Two parameters are deliberately distinct because Womblex's schema forces it:
`ELEMENT_SCHEMA` has a real `page` column (the printed page the element appeared
on, a *filter*), and pagination needs its own cursor. They are `page_number` and
`offset`/`limit` respectively. Collapsing them into one `page` argument is the
obvious mistake and would silently mean two different things to caller and
implementation.

`element_kinds` filters on Womblex's `kind` column. The non-text kinds (`table`,
`image`, `figure`, `form`, `page_break`, `sheet_meta`, `sheet_cell`) carry
`text: None`. That null is **served as null** — an element with no text is a real
element, not a gap, and is never dropped, because dropping one breaks `elem_order`
contiguity. Folding `alt_text` into `text` is not open to this tool: it would put
a derived value in an extracted column.

This is the first tool to carry §2's payload-shape rules — null keys omitted,
`source_hash` hoisted to the envelope, `truncatedBy` reported — and it replaces
`read_extraction_elements`, which is deleted in the same commit.

_Exit: a document's elements come back 20 at a time, in `elem_order`, with
`returned`/`available`/`truncated` honest at every page; a kind filter and a page
filter each narrow the set; the last page reports `truncated: false`; a
`text: null` element survives to the caller._

### 4. `get_document_entities` — the graph, as navigation

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

### 5. `get_verbatim_data` — exact bytes for one named thing

Exact bytes for a document plus an element, chunk or cell reference, echoing back
the anchor it resolved. This is the end of every navigation path: the client has
narrowed to one passage and wants precisely it.

_Exit: the returned text is byte-identical to the shard's value for each reference
kind; an unresolvable reference is a `NOT_FOUND` error, never an empty string._

### 6. `get_schema` — the two scopes that read values

**One extracted table's actual header row**, read verbatim from its cells, and a
document's graph vocabulary (entity labels and relation names present). The
asset-columns scope moved to step 2.

The table scope is the one that matters for defining a report column — it is what
lets a client use the words the document actually uses instead of guessing them.

_Exit: both scopes answer against the real fixture corpus; the table scope returns
the header row's exact strings, not a normalised form._

### 7. The remaining shard reads

`list_runs`, `read_form_fields`, `read_money_spans`, `read_chunks` and
`read_table_cells` over the asset-reader port, all paginated and document-scoped on
the same terms as step 3, and all carrying §2's payload-shape rules. The
`read_extraction_chunks` and `read_extraction_table_cells` tools, which still
default to 500 rows, are deleted here.

Money spans carry a caveat the tool description must state, because getting it
wrong corrupts amounts silently: `value` is exact and **already folds in sign and
multiplier**. `multiplier` and `negative` are an audit trail, not arithmetic to
redo.

_Exit: every tool answers against the fixture corpus, ordering stable, paging
honest._

### 8. Retire the per-document read model

Once nothing calls it: `GET /extractions/...`, `records.py`'s DTOs,
`shard_reader.py`'s mapping and `real_extractor.py`'s three-family read.
`shards.py` supersedes all of it. Note that `derive_is_currency` lives in
`shard_reader.py` and is the derived signal the retired read model relabelled — a
document's currency signal, when a tool needs one, belongs under a labelled
`derived` key above the verbatim rows, never folded in among Womblex's columns.

_Exit: the route and its mapping are gone; the sidecar suite stays green._

### 9. A second corpus

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

**The read seam materialises a whole asset before paging it.** `shards.py::_decode`
decodes every shard file for an asset and `read_shard` slices the window
afterwards, so `limit`/`offset` bound the *payload* and not the work behind it. A
run-wide read on a large corpus — `list_documents`' `entities` read is the first
one — is held in full sidecar-side whatever the cap. Correctness at run size is not
affected; the cost is. Pushing the filter and the window down into the Parquet read
is the fix, and it is a sidecar change, not a tool change.

**A derived count put breadth and body in one read — §4 step 1 is the fix.**
`chunk_count` and `page_count` are absent from `list_documents` because `chunks`
and `elements` both carry `text`, so counting rows or taking a max over
`elements.page` pulled every document's body through the seam to produce one
number. Aggregating in the sidecar is the answer, and it is cheaper than the note
above assumed: Parquet keeps row counts in the footer and supports column
projection, so a count needs no row decode and a page range reads one int column.
That is done: `shape.py` is where these counts land, and `list_documents` can carry them once step 1 serves them.

**Nothing checks the Womblex version.** The contract records v0.4.0. A corpus
written by an older engine fails at the first missing column rather than at a
version check.

**Redline does not authenticate.** It assumes deployment isolation. If it is ever
reachable beyond that, these tools read commercial-in-confidence documents with no
caller identity at all.

**What is a `corpusId`, to a client?** Redline takes it on trust and has no way to
validate it beyond "shards exist under that prefix".

**The row cap lives in the tool layer, as a pair.** Settled: 20 rows / 20,000
characters by default, 200 / 80,000 as the ceiling `limit` may be raised to,
enforced server-side, with `truncatedBy` naming which bound. The sidecar keeps its
own `DEFAULT_LIMIT` of 500 as a transport guard below the boundary. The tools'
current `DEFAULT_TOOL_LIMIT` of 500 is inherited from that transport default
rather than chosen — measured against the real elements capture (mean 711 bytes a
row) it is ~90k tokens in one call, and on a document with real paragraphs several
times that. It is replaced tool by tool in steps 3 and 7; until then two reads
still carry it.

**How large a corpus has this been proven against?** One run, one document. Every
cost claim above is measured, but measured small — the byte-per-row figures come
from a 24-element FOI notice. Step 9 is what turns them into evidence.

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
