# Redline — Functional Requirements

**Status:** Draft for review
**Date:** 2026-08-20
**Audience:** Business and product reviewers
**Source of truth:** [`docs/Redline-Plan.md`](./Redline-Plan.md) — this document restates
that plan's behaviour as testable requirements. Where the two disagree, the plan wins and
this document is corrected.

**Scope:** redline only. The report-assembly journey redline participates in is
specified in [`Wayfinder-Integration.md`](./Wayfinder-Integration.md), which is also
where every requirement that moved out of this document now lives.

---

## 1. Purpose

Redline serves what Womblex extracted, exactly as Womblex wrote it, so that a report
assembled from it is grounded in source rather than in a model's recollection.

The product's promise is not "the answer". It is **"here is the exact source, and it
has not been touched on the way to you"**. Every requirement below protects that: if
redline cannot return the real bytes, it returns an error, and never something
plausible in their place.

## 2. Where this sits

Three services, one journey.

- **Womblex** extracts documents into versioned Parquet assets. Upstream of redline
  and not covered here.
- **Redline** — this document — serves those assets verbatim over MCP.
- **Wayfinder** orchestrates the human-guided assembly and export. Downstream of
  redline and covered in `Wayfinder-Integration.md`.

Redline has no user. Its caller is a client LLM working on a person's behalf, and
every requirement below is about what that caller is given and what it is refused.

## 3. Scope

### In scope for v1

- Read-only access to a Womblex run's extraction assets over MCP
- Dynamic schema discovery — what columns an asset has, what headers a specific
  extracted table actually carries, what a document's graph contains
- Verbatim fetch of text, cells and structures by document and reference
- Run-scoped reads, so a corpus read twice returns the same bytes
- Explicit, typed errors at every boundary

### Explicitly out of scope for v1

- Any LLM call, generation, summarisation, paraphrase or inference
- Any persistence — no database, no run state, no stored report
- Any user interface
- Column definitions, report rows, value statuses, constraints, normalisation, export
- Similarity search over the embeddings Womblex writes (it ships no index; see the
  plan's §3)
- Authentication (see the plan's §8 open question 1)

## 4. Glossary

| Term | Meaning |
|---|---|
| **Corpus** | A set of documents Womblex processed together, addressed by `corpusId` |
| **Run** | One Womblex pass over a corpus, `run-YYYYMMDDTHHMMSSZ`. Several co-exist |
| **Asset** | One Parquet shard family — elements, chunks, table cells, form fields, money spans, graph edges, … |
| **Document id** | Womblex's `source_hash`, the sha256 of the source document |
| **Chunk id** | `{source_hash}:{chunk_index}` |
| **Verbatim** | Byte-identical to what Womblex wrote — no trimming, re-encoding or reformatting |
| **Derived** | Computed by redline rather than read from a shard. Always labelled as such |

## 5. Functional requirements

### 5.1 Serving source

**FR-1.1 — Values are returned byte-identical to the shard**

> **Given** a client requests any value redline serves
> **When** redline returns it
> **Then** it is byte-identical to the value in the Womblex shard
> **And** it has not been trimmed, case-folded, re-encoded, whitespace-collapsed or
> reformatted.

---

**FR-1.2 — Column names are Womblex's own**

> **Given** a client reads any asset
> **When** redline returns the rows
> **Then** the column names are the ones Womblex wrote — `source_hash`, `elem_order`,
> `parent_elem_order` — not names redline invented
>
> *Business rationale: a client that reads redline's names cannot join what it read
> back to the source, and cannot be pointed at Womblex's own documentation.*

---

**FR-1.3 — Redline generates nothing**

> **Given** any request redline cannot answer from stored assets
> **When** redline responds
> **Then** it returns a typed error
> **And** it never returns content of its own composition — no summary, no
> paraphrase, no inferred value, no plausible substitute.

---

**FR-1.4 — Derived signals are labelled and separated**

> **Given** redline computes a signal that Womblex did not write — for example
> inferring that a table cell holds currency
> **When** it returns that signal
> **Then** the signal appears under an explicitly separate key marked as derived
> **And** it never appears among the extracted columns as though Womblex wrote it.

---

**FR-1.5 — An unresolvable reference is an error, not an empty answer**

> **Given** a client asks for a document, element, chunk or cell that does not exist
> **When** redline resolves the reference
> **Then** it returns a `NOT_FOUND` error naming what could not be resolved
> **And** it does not return an empty string, an empty list, or a zero row count that
> a caller could mistake for "this exists and is blank".

---

### 5.2 Run scoping

**FR-2.1 — Every read names its run**

> **Given** a corpus with more than one Womblex run
> **When** a client reads any asset
> **Then** the read is scoped to exactly one run
> **And** rows from other runs are never merged into the answer
>
> *Business rationale: a document silently served twice produces doubled evidence and
> element ordinals that identify nothing — plausible, and wrong.*

---

**FR-2.2 — The run list is discoverable and ordered**

> **Given** a client that does not yet know which run to read
> **When** it asks redline for the corpus's runs
> **Then** it receives them newest first, so "the latest run" needs no guessing.

---

**FR-2.3 — Reads are reproducible**

> **Given** the same corpus, run and arguments
> **When** a client repeats a read
> **Then** it receives identical bytes in identical order
> **And** where the read is capped, the cap falls in the same place.

---

### 5.3 Discovery

**FR-3.1 — A client can ask what an asset contains**

> **Given** a client that does not know an asset's shape
> **When** it asks redline for that asset's schema
> **Then** it receives the column names and types Womblex wrote.

---

**FR-3.2 — A client can ask what one extracted table's headers actually are**

> **Given** a specific table extracted from a specific document
> **When** a client asks redline for that table's schema
> **Then** it receives that table's own header row, verbatim
> **And** the headers are not normalised, title-cased or de-duplicated
>
> *Business rationale: this is what lets a client define a report column against the
> words the document actually uses, instead of guessing at them.*

---

**FR-3.3 — A client can ask what a document's graph contains**

> **Given** a document Womblex enriched
> **When** a client asks redline for its graph vocabulary
> **Then** it receives the entity labels and relation names actually present.

---

**FR-3.4 — An absent graph is distinguishable from an empty one**

> **Given** a client traverses a document's graph
> **When** no enrichment graph was loaded for that run
> **Then** redline says so explicitly
> **And** a client can tell that state apart from a loaded graph that matched nothing
>
> *Business rationale: "there is no graph" and "the graph has no such entity" lead to
> opposite next actions.*

---

### 5.4 Honest answers about size

**FR-4.1 — A capped read says it was capped**

> **Given** a read whose result exceeds redline's row cap
> **When** redline returns the rows
> **Then** the payload states how many were returned, how many matched, and that it
> was truncated
> **And** a caller can never mistake a capped answer for the whole answer.

---

### 5.5 Errors

**FR-5.1 — Failures cross the boundary as typed errors**

> **Given** any failure — a malformed request, an unreachable sidecar, a shard that
> does not parse
> **When** redline responds
> **Then** it returns a typed error carrying a code and a message
> **And** no exception is thrown across a package or process boundary.

---

**FR-5.2 — A missing asset is not an infrastructure failure**

> **Given** a corpus or run that does not exist
> **When** a client reads it
> **Then** the error distinguishes "not found" from "the store could not be reached"
>
> *Business rationale: one means the client asked for the wrong thing; the other means
> the deployment is broken. A caller retries only the second.*

---

## 6. Assumptions

1. Womblex has already run over the corpus and landed its shards in object storage.
   Redline neither triggers nor waits for a run.
2. The client is trusted at the deployment boundary. Redline performs no
   authentication and takes `corpusId` on trust.
3. Womblex's schema matches `Womblex-Output-Contract.md`. Nothing enforces this at
   runtime; a corpus written by an older engine fails at the first missing column.
4. Object storage is the only seam to Womblex. Redline never invokes the engine.

## 7. Open questions for the reviewer

1. Should redline authenticate its callers, or is deployment isolation sufficient?
2. Should redline refuse a corpus written by a Womblex release older than the
   contract records, rather than failing at the first missing column?
3. Is the row cap a per-call parameter a client may raise, or a fixed ceiling?
