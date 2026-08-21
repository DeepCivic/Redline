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
of it to solve alone.** A corpus is however many documents it is — commonly
hundreds, occasionally one. No number is designed for, because designing for a
number is how a surface acquires a call that works at the size it was tested on
and destroys the session at the size it meets. What holds at every size is the
shape of the work: **one document at a time, with the client's memory kept outside
its context window.**

The split that makes any corpus tractable:

| | Job | Owner |
|---|---|---|
| **Navigation** | Decide *which* documents and *which* passages matter, from metadata alone | **Redline** |
| **Retrieval** | Return the exact bytes for one narrow, named thing | **Redline** |
| **Accumulation** | Hold the facts gathered so far, across documents, so the model need not | **The client** |

Redline is a paginated catalogue and retrieval system. It never summarises, and it
never accumulates.

### The client's scratchpad is a CSV, and the tool surface is designed around it

**Redline assumes its client can write and re-read a CSV between tool calls.** That
is an assumption about the client, not a dependency on it: Redline never creates
the file, never reads it, and cannot tell whether one exists — rule 3 is
untouched. But it is the assumption that makes the surface coherent, because that
file, not the context window, is where a client's findings live.

The loop every tool is shaped to serve:

1. `list_documents` returns one bounded page of document metadata. The client
   appends those rows to its CSV as a worklist and pages until the worklist is
   complete. No document body has been read yet.
2. The client takes **one** document off the worklist and works it to completion
   — elements, entities, the verbatim passages it needs — appending findings as
   rows, each carrying the anchor it came from.
3. It marks that document done and moves to the next. Its context never holds two
   documents at once, and a context that is lost resumes from the CSV.

So a payload is a thing to be **appended**, not a thing to be read whole. That is
what dictates flat rows, a stable column order across pages, an anchor on every
row, and a cursor durable enough to sit in a spreadsheet cell overnight.

### One document at a time is enforced, not suggested

**Document scope is mandatory on every retrieval tool**, even where the sidecar
underneath would accept the filter as optional. There is no tool that returns
element text, cells, fields or spans across documents. A client that *can* ask for
a corpus will eventually ask for one, and no amount of guidance in a tool
description outranks a parameter that permits it.

Breadth exists only in navigation — `list_runs` and `list_documents` — which
return metadata and never a byte of document body.

**A request above the cap is refused, not quietly clamped.** A caller may raise a
page size up to the cap; above it, the answer is an error naming the cap and the
cursor to page with. A truncation flag tells a caller what it missed after the
fact; an error stops it forming the habit.

### What that demands of every tool

- **Metadata-first.** A client must be able to scan the whole landscape without
  reading raw text. Counts, names, ids, statuses — enough to choose, and not one
  byte of document body.
- **Small by default.** Retrieval tools default to a page of tens of rows, not
  hundreds. A caller may raise the page size to the cap; a request above the cap
  is an error, never a silent clamp.
- **Document-scoped.** Every retrieval tool takes a document and refuses without
  one. Only navigation spans a run.
- **Flat and appendable.** A row is scalar columns in a stable order, so a client
  writes it to CSV without flattening anything first. A value that is itself a
  list is a count in navigation and a separate document-scoped call for the
  members.
- **Every payload says what it withheld.** `returned`, `available`, `truncated`.
  A capped answer that looks complete is worse than an error.
- **Resumable.** A cursor encodes run, asset, filter and offset and nothing else,
  so Redline holds no handle for it and a stored cursor still works next week.
- **Every row carries its anchor**, so the next call can be narrower than the last.
  Navigation output is only useful if it addresses something.

---

## 3. What is present

### Packages

**`packages/redline-domain`** — ports and primitives. Zero external dependencies,
relative imports only, enforced by `validate.sh` #4 and ESLint.

- `result.ts` — the Result pattern (`{ data } | { error }`), `ok`/`err`/`isOk`/`isErr`
- `errors/domain-error.ts` — the error taxonomy
- `ports/procurement-extraction-reader.ts` — `IProcurementExtractionReader`, the
  one port: `readElements` / `readChunks` / `readTableCells`

**`packages/redline-adapters`** — one adapter, `WomblexExtractionReader`, over the
sidecar's per-document JSON route, with a hand-rolled wire validator (`wire.ts`).

### Apps

**`apps/redline-mcp`** — the MCP server, streamable HTTP, stateless, one transport
per request. `main.ts` is the process entry; `lib/container.ts` the wiring;
`lib/mcp-server.ts` the framing; `lib/report-tools.ts` the tools.

Three tools are exposed today, all whole-document reads:

| Tool | Backed by |
|---|---|
| `read_extraction_elements` | `IProcurementExtractionReader.readElements` |
| `read_extraction_chunks` | `.readChunks` |
| `read_extraction_table_cells` | `.readTableCells` |

Each caps at 500 rows and reports `returned` / `available` / `truncated`. **None of
them is navigable**: there is no filter, no offset, and no way to ask what a
document contains without pulling its text. §4 items 2 and 3 are that gap.

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

`./validate.sh` — 8 checks, currently **8 passed, 0 failed, 0 skipped**:
workspace typecheck, lint and test; `redline-domain` purity; no focused tests;
source file size; sidecar pytest; ruff. CI runs the same gate.

Tests today: 33 TypeScript (1 domain, 8 adapters, 24 MCP) and 116 Python.

---

## 4. Outstanding

Numbered locally; renumbered whenever the set changes. One commit each,
tests-first, with an explicit exit test.

The order is a dependency chain: 1 gives every later step a port, 2 gives every
later tool its envelope, and 7 gives 8 and 9 rows that the current fixture cannot
supply.

### 1. Move the adapter onto the generic seam

`IProcurementExtractionReader` and `WomblexExtractionReader` still read the
per-document route and remap Womblex's columns into camelCase DTOs —
`source_hash` becomes `documentId`, `parent_elem_order` becomes `elementOrder` —
and serve a **derived** `isCurrency` beside extracted columns as though Womblex had
written it. That breaks rule 1 in two ways: a client cannot join what it read back
to source, and a guess is presented as an extraction.

Replace with `IWomblexAssetReader` over the `/runs/...` routes, taking corpus, run,
asset, an optional document, and `limit`/`offset`. Derived signals move under a
separately labelled key. Delete the DTO port, the wire validator and the
per-document route with it.

The port's first argument is `evaluationId` throughout, and the sidecar route
spells it `{evaluation_id}` — vocabulary from before the restatement. It is a
`corpusId`, and this is the step that renames it, because the port is being
replaced anyway.

_Exit: a conformance fake satisfies the port; the adapter round-trips real fixture
rows with column names and values byte-identical to the shard, and a second page
continues where the first stopped._

### 2. The page envelope and the cap refusal

One shape, shared by every tool that follows, built before there is a tool to use
it. It is the guardrail from §2 made mechanical rather than advisory:

- `rows` — flat records, scalar columns only, in a **stable column order across
  pages**, so appending page two to a CSV lines up with page one.
- `returned` / `available` / `truncated` — honest at every page.
- `cursor` — an opaque encoding of run, asset, filter and offset, resolvable with
  no server-side state, `null` when the last page has been served.
- A request whose page size exceeds the cap returns a `LIMIT_EXCEEDED` error
  naming the cap. It does not clamp and it does not serve a partial page as
  though nothing were asked for.

Version bump intent when built: **MINOR** — it changes the shape of every existing
tool's response.

Test it with fabricated rows, not the fixture: the envelope is a pure contract, and
proving it needs an arbitrary row count rather than a realistic one. This is why no
tool below needs a large corpus to prove its paging.

_Exit: a page of fabricated rows pages to exhaustion with a stable column order,
`truncated` false only on the last page, and a `null` cursor there; a stored cursor
from page one still resolves after the reader is reconstructed; an over-cap request
errors and returns no rows._

### 3. `list_documents` — the navigation entry point

Metadata for a run's documents, and **no document text at all**. This is the
worklist: what a client pages through and writes to its CSV before it opens
anything.

Per document, one flat row, from `manifest.parquet` unless noted:

| Field | Source |
|---|---|
| `source_hash`, `doc_id`, `filename`, `ext`, `status` | manifest, verbatim |
| `elements_count`, `table_cells_count`, `form_fields_count` | manifest, verbatim |
| `title`, `doc_type_enriched`, `jurisdiction` | `enrichment_meta`, verbatim — absent when the enrich stage did not run |
| `entity_count` | count over `enrichment_entities` — the **names** come from step 5, per document |
| `chunk_count`, `page_count` | **derived** — a count over `chunks`, a max over `elements.page`. Returned under a labelled `derived` key, never among the manifest columns |

Filtering is exact-match over the metadata columns only — never a text search over
document bodies, which is a capability Redline does not have and must not fake.
Entity **names** are filterable here (find the documents that mention a party)
without being returned here: a per-document list of names is the nested,
unbounded value §2 rules out of a navigation row, and step 5 already serves it
document-scoped.

_Exit: a run's documents come back as flat rows carrying no document text, paging
through the step 2 envelope; a metadata filter and an entity-name filter each
narrow the set; derived fields sit under the labelled key and never among the
manifest columns._

### 4. `get_document_elements` — paginated verbatim retrieval

One document's elements, verbatim, **strictly paginated** — default 20, never
unbounded — filterable by element kind and by the document's printed page. The
document argument is required; there is no run-wide form of this call.

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
filter each narrow the set; the last page reports `truncated: false`; a call
without a document is an error._

### 5. `get_document_entities` — the graph, as navigation

One document's entities and graph edges, verbatim: `entity_id`, `entity_label`,
`name`, `entity_type`, `role`, `mention_start`/`mention_end`, `chunk_index`, and
the `source_id`/`target_id`/`relation` edges between them. This is also where the
names behind step 3's `entity_count` are served.

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

### 6. `get_verbatim_data` — exact bytes for one named thing

Exact bytes for a document plus an element, chunk or cell reference, echoing back
the anchor it resolved. This is the end of every navigation path: the client has
narrowed to one passage and wants precisely it.

_Exit: the returned text is byte-identical to the shard's value for each reference
kind; an unresolvable reference is a `NOT_FOUND` error, never an empty string._

### 7. A fixture that exercises what the current one cannot

`run-throsby-demo` has **empty** `table_cells` and `money_columns`, two
`money_spans` both narrative locus, one document and one run — and the run-scoping
test stages its second run by copying the first, so two runs that must differ are
byte-identical.

What is missing is **kinds of row, not volume of row**. Paging and the cap are
proved by step 2 against fabricated rows, so this fixture is not a breadth
exercise and must not become one; a large corpus here would slow every suite to
demonstrate a property already held by the envelope.

What it needs: a **priced schedule** so `table_cells` and `money_columns` are
populated and money spans exist at a non-narrative locus; enough documents that a
page boundary and a metadata filter both fall somewhere real — a handful, not
hundreds; and **two genuinely different runs** over the same documents, so a
changed value under a stable anchor proves run scoping the way a copy cannot.

_Exit: the table-cell path reads a real priced schedule; `list_documents` pages
across a boundary and filters to a strict subset; the same document read under two
run ids returns different values under the same anchor._

### 8. `get_schema` — dynamic discovery

Three scopes: an asset's columns and types; **one extracted table's actual header
row**, read verbatim from its cells; a document's graph vocabulary (entity labels
and relation names present).

The table scope is the one that matters for defining a report column — it is what
lets a client use the words the document actually uses instead of guessing them.
It is also why this step follows the fixture: there is no header row to read until
`table_cells` holds one.

_Exit: each scope answers against the real fixture corpus; the table scope returns
the header row's exact strings, not a normalised form._

### 9. The remaining shard reads

`list_runs`, `read_form_fields`, `read_money_spans`, `read_chunks` and
`read_table_cells` over the step 1 port, all paginated on the step 2 envelope.
`list_runs` is navigation and is run-wide; the four reads are retrieval and take a
required document, on the same terms as step 4.

Money spans carry a caveat the tool description must state, because getting it
wrong corrupts amounts silently: `value` is exact and **already folds in sign and
multiplier**. `multiplier` and `negative` are an audit trail, not arithmetic to
redo.

_Exit: every tool answers against the step 7 fixture, ordering stable, paging
honest; each of the four reads errors without a document._

### 10. Retire the per-document read model

Once nothing calls it: `GET /extractions/...`, `records.py`'s DTOs,
`shard_reader.py`'s mapping and `real_extractor.py`'s three-family read.
`shards.py` supersedes all of it. Note that `derive_is_currency` lives in
`shard_reader.py` and is the derived signal step 1 relabels — it moves rather than
dies.

_Exit: the route and its mapping are gone; the sidecar suite stays green._

---

## 5. Known gaps and open questions

**`_select_run` is now redundant but still live.** `real_extractor.py` narrows to
one run inside the extractor, which was the partial fix for run scoping. The
`/runs/...` routes do it properly. It goes with step 10.

**Nothing checks the Womblex version.** The contract records v0.4.0. A corpus
written by an older engine fails at the first missing column rather than at a
version check.

**Redline does not authenticate.** It assumes deployment isolation. If it is ever
reachable beyond that, these tools read commercial-in-confidence documents with no
caller identity at all.

**What is a `corpusId`, to a client?** Redline takes it on trust and has no way to
validate it beyond "shards exist under that prefix".

**How high is the cap, in rows?** §2 settles the policy — a caller may raise a page
size to the cap and is refused above it — and step 2 implements it, but the number
itself is still a judgement call, and it is the number that decides whether a
careless call can exhaust a context window.

---

## 6. What Redline is not

Recorded so its absence is not mistaken for missing work and rebuilt. All of it
belongs above Redline, in whatever calls it.

- Report definitions, rows, values, and the state accumulated across documents
- **The client's CSV scratchpad.** Redline's payloads are shaped to be appended to
  one (§2) and its tool descriptions name the loop that does it, but Redline never
  creates, reads, writes or validates that file, and holds no notion of which
  documents a client has already worked
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
