# ADR-0003 — The womblex extraction boundary is JSON (sidecar reads Parquet, serves JSON)

- **Status**: Accepted
- **Date**: 2026-07-25

## Context

Build plan §8 decision #2 — *"Parquet boundary (Thread 4) — womblex sidecar emits
**JSON** (recommended) vs a Parquet-reading TS adapter"* — is marked *decide in
Thread 4*. Thread 4 implements `IProcurementExtractionReader` (elements / chunks /
table cells + provenance) in `packages/redline-adapters`, so the shape of the seam
between the Python `womblex-ingest` sidecar and the TypeScript adapter must be fixed
now.

womblex writes **Parquet shards** to object storage (`*.elements.parquet`,
`*.table_cells.parquet`, `*.chunks.parquet`, `_manifest.parquet`) with provenance
keys `source_hash`, `elem_order`, `page`/`bbox`, `chunk_id = "{source_hash}:{chunk_index}"`,
and currency-typed cells. The domain, however, is a strict zero-dependency
TypeScript package that only wants typed provenance objects.

Two options:

- **A. Sidecar emits JSON.** The sidecar (which already owns womblex + Parquet)
  reads its own shards and serves a typed JSON read model; the TS adapter is a thin
  HTTP+JSON mapping.
- **B. Parquet-reading TS adapter.** The adapter pulls the Parquet objects from
  MinIO and parses them in TypeScript.

## Decision

**The boundary is JSON (option A).** The `womblex-ingest` sidecar exposes a
document-scoped read seam:

```
GET /extractions/{evaluationId}/{documentId}
  → 200 { documentId, elements[], chunks[], tableCells[] }
```

- The sidecar reads its own Parquet shards and normalises womblex's provenance keys
  (`source_hash` → `documentId`, `elem_order` → `elementOrder`, `chunk_id`, currency
  cells) into a camelCase JSON read model. This mapping lives in exactly one place
  (`records.py` + `real_extractor.py`) — the only code that understands womblex's
  schema.
- The JSON payload's field names match `IProcurementExtractionReader`'s DTOs
  (`ExtractionElement` / `ExtractionChunk` / `ExtractionTableCell`) exactly, so
  `WomblexExtractionReader` in `redline-adapters` is an allocation-only mapping over
  HTTP + JSON.
- The JSON read model is stored beside the Parquet shards as
  `proc/{evaluationId}/{documentId}.extraction.json`, so the read seam is durable
  across a sidecar restart (MinIO remains the record, per ADR-0002).
- Errors cross Result-shaped (`{"error":{"code","message"}}`); the adapter maps
  `NOT_FOUND` through and treats other read-seam failures as `EXTRACTION_FAILED` /
  `INFRA_FAILURE`.

## Consequences

**Positive**

- The TypeScript packages take **no Parquet dependency** — the heavy, Python-native
  Parquet/Arrow stack stays entirely in the sidecar that already carries womblex.
- One schema-aware boundary: womblex's key vocabulary is understood in a single
  module, keeping the domain and adapter free of womblex-isms.
- Honours ADR-0001's "design as if C": the adapter's only coupling to the sidecar is
  HTTP + JSON, so the seam stays fully runtime-decoupled.
- Testable offline: the deterministic stub extractor emits the same JSON read model,
  so the adapter's contract test runs with zero external dependencies against a
  captured fixture.

**Negative**

- The read model is materialised twice (Parquet + JSON) in object storage. Cheap and
  acceptable; the JSON is small next to the shards, and it buys durability + a
  Parquet-free TS surface.
- A very large document's JSON payload is served in one response. Acceptable for the
  review flow's document sizes; pagination/streaming can be layered on the same seam
  later without a domain change if it proves necessary.

## Alternatives considered

- **B. Parquet-reading TS adapter.** Rejected: pulls a Parquet/Arrow dependency (and
  its native bindings) into the TypeScript workspace, duplicates womblex-schema
  knowledge on the TS side, and complicates the Thread 16 standalone extraction.
  The plan already flagged JSON as recommended; nothing about the review flow needs
  TS-side Parquet.

## Enforcement

- `WomblexExtractionReader` depends only on an injected `HttpClient` (a `fetch`-shaped
  seam) and `@redline/redline-domain` — no Parquet/S3 client, no Node built-ins.
- The adapter's contract test reads a **captured** sidecar payload fixture
  (`src/womblex/__fixtures__/extraction-*.json`) and asserts the typed mapping plus
  the error taxonomy, so the JSON contract is pinned on both sides.
- `redline-domain` purity (validate.sh check #4) keeps the port DTOs dependency-free,
  so the wire shape can only ever be plain data.
