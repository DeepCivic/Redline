# Redline — state of the repo

> **Redline is a read-only MCP server providing verbatim access to Womblex
> extraction assets for provenance-backed report assembly.**

One document: what is actually in this repository today, and what is outstanding.
It replaces the former `Redline-Status.md` / `Redline-Functional-Requirements.md`
pair, which had drifted into describing a report engine redline no longer is.

Two reference documents sit beside it and are **not** superseded:

- [`Womblex-Output-Contract.md`](./Womblex-Output-Contract.md) — every Parquet
  schema redline reads. Read column names from there, never from memory.
- [`Wayfinder-Integration.md`](./Wayfinder-Integration.md) — the contract
  Wayfinder builds against, and the trust rules it owns.

---

## 1. The boundary

| | Responsibility | Boundary |
|---|---|---|
| **Womblex** | Ingests unstructured documents; persists elements, chunks, table cells, form fields, money spans and graph edges as versioned Parquet assets | The source of truth. No LLM generation, no report assembly |
| **Redline** (here) | Serves those assets verbatim over MCP, so a client can discover schemas and fetch exact source snippets | Headless, stateless, read-only. Refuses to paraphrase or generate |
| **Wayfinder** | The chat surface where an LLM helps a person define a report schema, then assembles the report from redline's reads, and exports it | All UI, user intent and workflow state. Delegates every fetch to redline |

Womblex reaches redline through object storage; redline reaches Wayfinder through
one MCP endpoint. **No submodules** — neither upstream is carried in this tree.

Four rules, non-negotiable, that everything below is measured against:

1. **Verbatim or nothing.** Values are byte-identical to what Womblex wrote.
2. **No generation.** No LLM client, no model call, no inference. An error, never
   a plausible substitute.
3. **No persistence.** No database, no run state, no report.
4. **Every read is run-scoped.** Runs co-exist under one corpus prefix; a read
   that spans them serves each document once per run and its provenance keys stop
   identifying anything.

---

## 2. What is present

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

Three tools are exposed today:

| Tool | Backed by |
|---|---|
| `read_extraction_elements` | `IProcurementExtractionReader.readElements` |
| `read_extraction_chunks` | `.readChunks` |
| `read_extraction_table_cells` | `.readTableCells` |

Each caps at 500 rows and reports `returned` / `available` / `truncated`.

### Services

**`services/womblex-ingest`** — the Python read sidecar (FastAPI). Reads Womblex's
Parquet from object storage and serves JSON, so redline's TypeScript never links a
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
spellings, exact decimal serialisation, and honest paging. `embeddings` is
catalogued and deliberately refused — Womblex ships no index, so nothing can rank
those vectors.

### Infrastructure

`infra/docker-compose.yml` — two profiles: `ingest` (MinIO + sidecar) and `report`
(the MCP server). The Womblex engine is **not** in this stack; it runs from its own
repo and publishes to shared object storage. `infra/womblex/redline.yaml` is the
run profile redline's reads assume, handed to that externally-run engine.

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

Tests today: 32 TypeScript (1 domain, 8 adapters, 23 MCP) and 116 Python.

---

## 3. Outstanding

Numbered locally; renumbered whenever the set changes. One commit each,
tests-first, with an explicit exit test.

### 1. Move the adapter onto the generic seam

`IProcurementExtractionReader` and `WomblexExtractionReader` still read the
per-document route and remap Womblex's columns into camelCase DTOs —
`source_hash` becomes `documentId`, `parent_elem_order` becomes `elementOrder` —
and serve a **derived** `isCurrency` beside extracted columns as though Womblex
had written it. That breaks rule 1 in two ways: a client cannot join what it read
back to source, and a guess is presented as an extraction.

Replace with `IWomblexAssetReader` over the `/runs/...` routes, taking corpus, run,
asset and an optional document. Derived signals move under a separately labelled
key. Delete the DTO port, the wire validator and the per-document route with it.

_Exit: a conformance fake satisfies the port; the adapter round-trips real fixture
rows with column names and values byte-identical to the shard._

### 2. `get_schema`

Three scopes: an asset's columns and types; **one extracted table's actual header
row**, read verbatim from its cells; a document's graph vocabulary (entity labels
and relation names present).

The table scope is the one that matters for report definition — it is what lets a
client define a column against the words the document actually uses.

_Exit: each scope answers against the real fixture corpus; the table scope returns
the header row's exact strings, not a normalised form._

### 3. `get_verbatim_data`

Exact bytes for a document plus an element, chunk or cell reference, echoing back
the anchor it resolved.

_Exit: the returned text is byte-identical to the shard's value for each reference
kind; an unresolvable reference is a `NOT_FOUND` error, never an empty string._

### 4. Full shard coverage in the tool surface

`list_runs`, `list_documents` (from the manifest — the only shard mapping a
`source_hash` back to a filename), `read_form_fields`, `read_money_spans`, and the
three graph tools (`graph_find_entities`, `graph_edges_from`, `graph_edges_to`).

The graph **locates**; it never sources. An edge points at the chunk an entity was
found in; a value found by traversal still cites its chunk.

_Exit: every tool answers against the fixture corpus, ordering stable; a graph tool
distinguishes "no graph loaded" from "graph loaded, no match"._

### 5. Retire the per-document read model

Once nothing calls it: `GET /extractions/...`, `records.py`'s DTOs, `shard_reader.py`'s
mapping and `real_extractor.py`'s three-family read. `shards.py` supersedes all of it.
Note that `derive_is_currency` lives in `shard_reader.py` and is the derived signal
step 1 relabels — it moves rather than dies.

_Exit: the route and its mapping are gone; the sidecar suite stays green._

### 6. A second corpus

The fixture has **empty** `table_cells` and `money_columns`, two `money_spans` both
narrative locus, and one run. So it cannot prove the table-cell or sheet-cell
paths, and cannot regress the run-scoping guarantee for real (the current test
stages two runs by copying one). A tender with a priced schedule, run twice.

_Exit: a corpus with two runs and a populated pricing table proves the table-cell
read and run scoping together._

### 7. The Wayfinder half — not in this repo

Specified in [`Wayfinder-Integration.md`](./Wayfinder-Integration.md), buildable
only in Wayfinder: the schema-definition form renderer, the agent wiring that
calls redline's tools, the client-side trust rules (reject unoffered columns,
reject uncited evidence, flag non-substring quotes without rewriting them), and
CSV export.

---

## 4. Known gaps and open questions

**`_select_run` is now redundant but still live.** `real_extractor.py` narrows to
one run inside the extractor, which was the partial fix for run scoping. The
`/runs/...` routes do it properly. It goes with step 5.

**Nothing checks the Womblex version.** The contract records v0.4.0. A corpus
written by an older engine fails at the first missing column rather than at a
version check.

**Redline does not authenticate.** It is registered as an internal,
non-externally-communicating server, which assumes deployment isolation. If it is
ever reachable beyond that, these tools read commercial-in-confidence documents
with no caller identity at all.

**What is a `corpusId`, to a client?** Redline takes it on trust. Whether it is a
Wayfinder identifier or a Womblex one needs settling with the Wayfinder work.

**Is the row cap a ceiling or a parameter?** The sidecar takes `limit`; the MCP
tools hard-cap at 500. Whether a client may raise it is unsettled.

---

## 5. What redline used to be

Recorded so its absence is not mistaken for missing work and rebuilt.

| Shed | Where it lives now |
|---|---|
| The report domain — definitions, runs, rows, values | Wayfinder's workflow state |
| redline's Postgres, its `redline_` schema and migrations | nowhere; redline is stateless |
| The base LLM extraction call and the per-document loop | Wayfinder's agent |
| Column constraints, money and date normalisation | Wayfinder, downstream of redline |
| Value statuses (`verified` / `missing` / `needs_review`) | Wayfinder |
| CSV and XLSX export | Wayfinder |
| `apps/redline-report` | never built; that loop is Wayfinder's |
| The Evaluation aggregate and the comprehension lens | removed 2026-08-15 |
| Any UI surface | Wayfinder |

**Two data lessons survive the move and are kept.**

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
