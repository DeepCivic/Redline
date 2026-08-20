# Redline — plan

> **Redline is a read-only MCP server providing verbatim access to Womblex
> extraction assets for provenance-backed report assembly.**

This file is the one live plan: what redline is, what it refuses to be, and the
outstanding build steps with their exit tests. §7 is the only place outstanding
work is tracked; a completed step is deleted from it, not ticked off.

---

## 1. The three services

Report assembly from unstructured documents is split across three products, each
with a boundary the other two rely on.

### Womblex — the extraction engine

Ingests unstructured data and persists rich, structured assets: Parquet shards
carrying elements, chunks, table cells, form fields, money spans and graph edges.

It is the **absolute source of truth**. It performs no LLM generation and no
report assembly. Its sole job is to produce high-fidelity, versioned data assets.

It is a separate repo. redline never runs it, never imports it, and never carries
its tree — the seam between them is object storage. The schemas redline reads are
recorded in [`Womblex-Output-Contract.md`](./Womblex-Output-Contract.md).

### Redline — the provenance-preserving MCP server

A strict, read-only gateway to Womblex outputs, for iterative report assembly.

**Core constraint: no LLM data generation.** redline returns verbatim,
byte-identical source text and structures, or it returns an error. It exposes MCP
tools that let a client LLM discover schemas dynamically ("what are the exact
column headers in this extracted table?") and fetch precise source snippets to
populate a report.

**Headless and stateless.** No UI, no database, no run state, no report. It
enforces provenance by refusing to paraphrase or generate, so the final report is
grounded entirely in Womblex's raw extraction.

### Wayfinder — the human-in-the-loop orchestrator

The user-facing interface where an LLM assists a human in assembling structured
reports from unstructured data. It handles all UI rendering, user intent and
workflow state, and delegates every fetch to redline's MCP so the AI never
hallucinates source data.

Two features belong to Wayfinder, not here:

1. **AI-driven form fields.** The chat UI detects when the AI needs to define a
   report schema and renders a dynamic form ("name this column", "define this
   field"). The human fills it out; the AI uses that schema to query redline's
   tools for the exact verbatim data to populate the report.
2. **CSV export.** A dedicated action exporting the assembled, source-verified
   report to `.csv`.

§6 records what redline shed to make this split real, so it is not re-derived as
missing work.

---

## 2. What "verbatim" costs, and why it changes the seam

Serving data verbatim is not the same as serving it conveniently, and the
existing read seam does not satisfy it. `GET /extractions/{corpusId}/{documentId}`
maps Womblex's columns into camelCase DTOs on the way out: `source_hash` becomes
`documentId`, `parent_elem_order` becomes `elementOrder`, and `isCurrency` is
**derived from the cell text** and then served beside extracted columns as though
it were one.

Three problems, in increasing order of seriousness:

1. A client asking "what columns does this asset have?" is told redline's names,
   not Womblex's — so it cannot join what it reads back to the source, and cannot
   be pointed at Womblex's own documentation.
2. Every new shard family costs a hand-written DTO, a mapping and a route. That is
   why the surface covers three of the twelve shard families two years into the
   schema's life.
3. A derived value presented as an extracted one is exactly the failure this
   product exists to prevent. `isCurrency` is a guess about whether a cell is
   money. It may well be a good guess. It is not what Womblex wrote.

So the seam changes shape: **one generic, schema-carrying shard read** that
serves Womblex's own column names and values untouched, for any shard family.
Every read returns the rows *and* the schema they conform to, which is what makes
dynamic discovery possible at all — `get_schema` is then the schema half of the
same read rather than a second mechanism.

Derived signals do not disappear; they stop pretending. Anything redline computes
is returned under an explicitly separate key and labelled as derived, never mixed
into the extracted columns.

---

## 3. The tool surface

Every tool is a pure read: safe to call, idempotent, and returning identical bytes
for identical arguments. Every tool is **run-scoped** (§5).

| Tool | Answers |
|---|---|
| `list_runs` | which runs exist for a corpus, newest first |
| `list_documents` | the run's documents — `source_hash`, `doc_id`, `filename`, `status`, from `manifest.parquet` |
| `get_schema` | the columns and types of a Womblex asset; or one extracted table's actual header row; or the entity labels and relation names present in a document's graph |
| `get_verbatim_data` | exact, byte-identical text or cells for a document and an element/chunk reference |
| `read_extraction_elements` | the ordered element stream — the coordinate space every anchor cites |
| `read_extraction_chunks` | chunks, keyed on `{source_hash}:{chunk_index}` |
| `read_extraction_table_cells` | a document's table cells at their `(row, col)` anchors |
| `read_form_fields` | a document's form fields — name, value, type |
| `read_money_spans` | money spans as Womblex wrote them |
| `graph_find_entities` | people, places and terms, with the chunk each was found in |
| `graph_edges_from` / `graph_edges_to` | one-hop relations between entities |

`get_schema` and `get_verbatim_data` are the pair that makes iterative assembly
work: discover what a document's structures actually contain, then fetch exactly
the bytes that fill a report cell.

**The graph locates; it never sources.** A graph edge is a navigation pointer to a
chunk, not evidence in itself. A value transferred into a report cites the chunk,
regardless of whether the chunk was found by direct fetch or by traversal.

**There is no similarity search.** Womblex writes `*.embeddings.parquet` and ships
no index — the vectors sit on disk and nothing ranks them. A client works from ids
and anchors it was given, or traverses the graph. Building the search seam belongs
sidecar-side (query embed, cosine over the corpus's vectors) and only once a
measurement says pointing is insufficient — not before.

### What every payload states

A capped read must be visibly capped, or a client treats a truncated answer as the
whole answer. Every payload carries `returned`, `available` and `truncated`
alongside its rows, and ordering is stable, so two identical calls are identical
and a cap falls in the same place both times.

---

## 4. Architecture

| Layer | Path | Role |
|---|---|---|
| Engine | *(separate repo)* | writes Parquet shards to object storage. Never reimplemented, never carried here |
| Read seam | `services/womblex-ingest` | Parquet → JSON, run-scoped, schema-carrying |
| Ports + types | `packages/redline-domain` | the read ports. Zero dependencies, Result pattern, ports only |
| Implementations | `packages/redline-adapters` | the sidecar HTTP client |
| Tool surface | `apps/redline-mcp` | the MCP server over streamable HTTP |
| UI | *(Wayfinder, separate repo)* | everything user-facing |

**Transport is constrained, not chosen.** Wayfinder's MCP client speaks SSE and
streamable-HTTP only — no stdio — and addresses servers by URL, so redline is a
long-running service with a URL. It runs stateless, one transport per request:
the tools are pure reads with no cross-call state, so there is nothing a session
would carry, and it removes a class of failure (a session map outliving its
client, 404s after a restart).

**Register it in Wayfinder with `communicatesExternally: false`.** The flag
classifies whether a server talks *outside* Wayfinder, and this one does not — it
reads object storage inside the same deployment and sends nothing anywhere. That
it reads commercial-in-confidence documents is a confidentiality concern about the
data, not about egress. Asserting `true` has teeth: an external server is
registered but *not selectable in flows*, which would make the assembler
unbuildable.

---

## 5. Every read is run-scoped

Multiple Womblex runs co-exist under one corpus prefix by design — retention keeps
the current run plus the previous one. The engine lands each under
`proc/{corpusId}/runs/{runId}/documents/`.

`RealWomblexExtractor.extract` lists the whole `proc/{corpusId}/` prefix and
concatenates by suffix, merging every run beneath it. A corpus run twice therefore
serves every document twice, `elementOrder` identifies nothing, and the duplicate
rows are individually plausible — which is the dangerous kind of wrong.

`_select_run` narrows to the latest run (or a named one) and is the partial fix
already in place. It is not enough: run selection belongs in the route, so a
client names the run it is reading and gets the same bytes tomorrow. **No read is
trustworthy until every route is run-scoped**, and no build step below may add a
route that is not.

---

## 6. What redline is not, and used to be

Recorded so it is not mistaken for missing work and rebuilt by a later session.

| Shed | Where it lives now |
|---|---|
| The report domain — definitions, runs, rows, values | Wayfinder's workflow state |
| redline's Postgres, its `redline_` schema and migrations | nowhere; redline is stateless |
| The base LLM extraction call (`IExtractionModel`) and the per-document loop | Wayfinder's agent |
| Column constraints and money/date normalisation | Wayfinder, downstream of redline's reads |
| Value statuses (`verified` / `missing` / `needs_review`) | Wayfinder |
| CSV and XLSX export | Wayfinder |
| `apps/redline-report` | never built; the loop it would have run is Wayfinder's |
| The Evaluation aggregate and the comprehension lens | removed 2026-08-15; interpreting a corpus was never a store-side concern |
| Any UI surface | Wayfinder |

**Two lessons from that history are kept, because they are about the data and
survive the move.**

*Money is already normalised, and re-normalising it corrupts it.*
`MONEY_SPANS_SCHEMA` carries an exact `decimal128(38,4)` `value` with sign and
multiplier **already folded in**. `multiplier` and `negative` are an audit trail of
how the amount was read, not arithmetic to redo. `modifier` ("up to",
"approximately") is deliberately not folded in, so a bounded amount is not an exact
one, and `range_group`/`range_role` link two rows that are one amount's endpoints.
redline states this in its tool descriptions and returns the columns untouched.

*A string parser that guesses is worse than one that refuses.* A parser stripping
everything outside `[0-9.]` turned `$1.234,56` into `1.23456`, `$1 234,50` into
`123450.0`, `-$500.00` into `500.0` and `($1,234.56)` into `1234.56` — a credit
summed as a debit. Two independent parsers is how that happened. redline no longer
parses money at all; whoever does, does it once, and refuses ambiguous digit
groupings rather than guessing.

---

## 7. Build steps

One commit each, tests-first, with an explicit exit test. A step whose exit test
joins two independently-testable behaviours is two steps.

1. **Run-scoped, schema-carrying shard read (sidecar).** Replace
   `GET /extractions/{corpusId}/{documentId}` with
   `GET /runs/{corpusId}` (the run list) and
   `GET /runs/{corpusId}/{runId}/shards/{asset}`, optionally document-filtered,
   returning `{columns: [{name, type}], rows: [...]}` with Womblex's own column
   names and values untouched. Fixes §5 in the route, not just the extractor.
   _Exit: a corpus with two runs serves each document once, from the named run;
   the served column names are Womblex's, asserted against the real fixture
   shards._
2. **The generic read port and adapter.** `IWomblexAssetReader` in
   `redline-domain` (zero deps, Result pattern) and its sidecar HTTP client in
   `redline-adapters`, over the step 1 routes. The three DTO-shaped extraction
   methods and their camelCase mapping go with it.
   _Exit: a conformance fake satisfies the port; the adapter round-trips real
   fixture rows with column names and values byte-identical to the shard._
3. **`get_schema`.** Three scopes: an asset's columns and types; one extracted
   table's actual header row, read verbatim from its cells; a document's graph
   vocabulary (entity labels and relation names present).
   _Exit: each scope answers against the real fixture corpus; the table scope
   returns the header row's exact strings, not a normalised form._
4. **`get_verbatim_data`.** Exact bytes for a document plus an element, chunk or
   cell reference, with the anchor it resolved echoed back.
   _Exit: the returned text is byte-identical to the shard's value for each
   reference kind; an unresolvable reference is a `NOT_FOUND` DomainError, never
   an empty string._
5. **Full shard coverage in the tool surface.** `list_runs`, `list_documents`,
   `read_form_fields`, `read_money_spans`, and the three graph tools, over the
   step 2 port. Derived signals (currency inference) move under an explicitly
   labelled key.
   _Exit: every tool answers against the fixture corpus, ordering stable; a graph
   tool distinguishes "no graph loaded" from "graph loaded, no match"._
6. **Second-corpus coverage.** The fixture corpus
   (`services/womblex-ingest/tests/fixtures/run-throsby-demo/`) has **empty**
   `table_cells` and `money_columns`, two `money_spans` both narrative locus, and
   one run — so it cannot prove the table-cell and sheet-cell paths, nor regress
   §5. Stage a second corpus that can.
   _Exit: a corpus with two runs and a populated pricing table proves the
   table-cell read and the run-scoping guarantee together._

---

## 8. Open questions

1. **Does redline authenticate?** It is registered as an internal,
   non-externally-communicating server today, which assumes deployment-level
   isolation. If it is ever reachable beyond that, the tools read
   commercial-in-confidence documents with no caller identity at all.
2. **What is a corpus id, to a client?** Wayfinder holds the workflow state that
   knows which corpus a report is about. redline takes the id on trust. Whether
   that is a Wayfinder identifier or a Womblex one needs settling with the
   Wayfinder work, not before it.
3. **Which Womblex release is the floor?** The contract doc records v0.4.0.
   Nothing enforces it at runtime, so a corpus written by an older engine fails at
   the first missing column rather than at a version check.
