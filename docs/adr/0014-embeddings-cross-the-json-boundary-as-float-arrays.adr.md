# ADR-0014 — Embeddings cross the JSON boundary as plain float arrays on a sibling resource

- **Status**: Proposed
- **Date**: 2026-07-25
- **Amends**: [ADR-0003](./0003-parquet-to-json-boundary.adr.md) — widens the sidecar's
  read seam from one document-scoped resource to two. ADR-0003's decision that the
  boundary is JSON, that the sidecar owns the Parquet stack, and that the TypeScript
  packages link no Parquet reader, all stand unchanged.

## Context

Design doc §9 open question #1 is Thread 19's to settle: *"Vector wire format —
JSON float arrays across the ADR-0003 boundary may not survive corpus scale.
Alternatives: a binary side channel, or keeping retrieval server-side in the
sidecar and shipping only neighbours."*

Finding 2 established that the retrieval leg already exists in womblex, not
Numbatch: `analyse/embed_stage.py` consumes `*.chunks.parquet` and writes an
`*.embeddings.parquet` **sibling** per batch — one vector per chunk, joinable back
on `(source_hash, chunk_index, content_type)`. redline already runs a womblex
sidecar over those shards. Retrieval is a shard we are not yet reading.

ADR-0003 fixed the seam for extraction: the sidecar reads its own Parquet and
serves `GET /extractions/{evaluationId}/{documentId}` as typed camelCase JSON,
stored durably beside the shards. Embeddings are the same boundary with a
materially different payload — a document's vectors are two to three orders of
magnitude larger than its text records — so the shape is not simply inherited.

The decision is load-bearing beyond this thread. Thread 20 builds
`IEmbeddingReader` + its adapter in TypeScript; Thread 22 computes
nearest-neighbour of chunk vectors against topic definitions in
`redline-application`. Both presuppose that vectors reach TypeScript at all,
which is exactly what option C would deny.

## Decision

**Embeddings cross the boundary as plain JSON float arrays, on a document-scoped
resource that is a sibling of the extraction — not folded into it.**

```
GET /embeddings/{evaluationId}/{documentId}
  → 200 {
      "documentId": "<source_hash>",
      "model": "<producing model id>",
      "dimensions": 8,
      "vectors": [
        { "chunkId": "<source_hash>:0", "chunkIndex": 0, "values": [0.37, …] }
      ]
    }
  → 404 { "error": { "code": "NOT_FOUND", "message": … } }
```

Five things this pins:

- **A sibling resource, not a field on `/extractions`.** Embeddings are an
  *optional overlay* on the extraction, exactly as womblex writes them: a sibling
  Parquet, never a rewrite of the verbatim base (design doc §3). A document may
  legitimately have an extraction and no embeddings — the embed stage did not run,
  or the deployment is air-gapped — so the two resources must be absent
  independently. This is what makes the thread's exit criterion *"absent shard →
  `NOT_FOUND`"* a normal outcome rather than a broken extraction. It also keeps
  the Thread 4 adapter from paying megabytes for a payload it never reads.

- **The join key is `chunkId`, the vocabulary the seam already speaks.**
  `chunkId = "{source_hash}:{chunk_index}"` is already `ChunkRecord`'s identity on
  the extraction wire (`records.py`), and it *is* the `(source_hash, chunk_index)`
  pair the exit test names. `chunkIndex` is carried alongside it as the explicit
  ordinal, and `documentId` is the `source_hash`, so a consumer can join on either
  the composite key or the pair without re-parsing a string. The one place that
  understands womblex's schema stays `records.py` + `real_extractor.py`.

- **`values` is a JSON array of numbers — not base64, not a binary side channel.**
  The wire stays plain data end to end, which is the property ADR-0003 bought and
  purity check #4 protects: a `number[]` needs no decode step, no `Buffer`/`atob`
  in the adapter, and no endianness convention. The seam remains inspectable with
  `curl`, and the deterministic stub can emit a readable fixture the Thread 20
  contract test pins on both sides. Size is mitigated where it is cheapest — HTTP
  compression over float text, and a resource scoped to one document.

- **Vectors cross L2-normalised, and the payload declares its `model` and
  `dimensions`.** Normalising at the producer makes cosine similarity a dot
  product downstream and removes an ambiguity Thread 22 would otherwise have to
  guess at. Declaring the model is not decoration: vectors from different models
  are incomparable, and Thread 22 must embed topic definitions with the *same*
  model it is matching against. A consumer that cannot honour the declared model
  should refuse rather than silently rank noise.

- **Storage mirrors ADR-0003.** The JSON read model is written beside the shards
  as `proc/{evaluationId}/{documentId}.embeddings.json`, so the read seam survives
  a sidecar restart and MinIO remains the record (ADR-0002).

## Consequences

**Positive**

- Threads 20 and 22 can be built as planned, in TypeScript, against a port whose
  DTOs are plain data. Nothing about retrieval leaks into Python.
- The optionality is structural, not conventional. A deployment without the embed
  stage returns `NOT_FOUND` on embeddings while extraction keeps working — which
  is precisely the degradation ADR-0008 promises, expressed at the seam.
- The format is self-describing. `model` + `dimensions` mean a stale or
  mismatched vector set is detectable at the boundary rather than as bad
  classifications three threads later.
- Debuggable and fixture-able offline: the stub extractor emits the same shape, so
  the Thread 20 contract test needs neither womblex nor MinIO.

**Negative**

- **JSON floats are roughly four to five times larger than packed float32.** At
  768 dimensions a chunk costs ~15 kB of text against ~3 kB packed; a 200-chunk
  document is a few megabytes per response. Acceptable for a document-scoped read
  and compressible on the wire, but it is a real cost and this ADR is choosing to
  pay it rather than pre-optimise a payload no measured corpus has yet strained.
- **Corpus-wide retrieval is N requests**, one per document. Thread 22 fans out
  rather than issuing one query. Honest for a first pass; a corpus-scoped resource
  is additive on the same seam if the fan-out becomes the bottleneck.
- **The read model is materialised twice** (Parquet + JSON), as ADR-0003 already
  accepted — but the duplication is much larger here in absolute terms.
- **Normalising at the producer is lossy for anyone who wanted raw magnitudes.**
  No current consumer does; if one appears it needs a flag, not a new format.
- **`content_type` is dropped from womblex's three-part join key.** Our
  `ChunkRecord` does not carry it, so adding it to embeddings alone would make the
  join asymmetric. If real womblex shards turn out to need it, it is an additive
  field on *both* records.

**Re-entry condition.** Revisit when a real corpus has been measured. Both
alternatives below remain reachable *additively* on this same resource — an
`encoding: "base64-f32"` discriminator on `values`, or a
`POST /embeddings/{evaluationId}/query` neighbours endpoint — and neither would
change the domain port. That is the point of settling the resource shape now and
the transport efficiency later.

## Alternatives considered

- **A binary side channel (base64 float32, or a separate octet-stream route).**
  Rejected as premature. It buys a ~4× payload reduction in exchange for an
  endianness convention, a decode step in the adapter, an opaque fixture, and a
  wire the domain can no longer describe as plain data — all before any corpus has
  demonstrated the JSON payload is a problem. The measurement should precede the
  optimisation, and the optimisation is additive when it comes.

- **Keeping retrieval server-side in the sidecar, shipping only neighbours.**
  Rejected on architecture, not performance. It would put topic definitions —
  a domain concept the sidecar has no business knowing — into Python, and move
  nearest-neighbour out of `redline-application` where Thread 22 places it. The
  lens's classification logic would then straddle two languages, with the
  interesting half in the service that is explicitly a *foreign-runtime sidecar
  composed over runtime seams* (ADR-0001's "design as if C"). It also forecloses
  the first-pass/overlay interchangeability D2 requires: both paths must produce
  `RequirementClassification` at the same port.

- **Folding `vectors` into the existing `/extractions` payload.** Rejected: it
  makes the Thread 4 adapter's response megabytes heavier for data it never reads,
  and it destroys the independent absence that makes embeddings an optional
  overlay. A document with no embed stage would then have to serve an empty array
  and hope the consumer noticed.

## Enforcement

- `records.py` gains `EmbeddingRecord` / `DocumentEmbeddings` beside the existing
  extraction dataclasses; the field names *are* the JSON keys, so the wire shape
  cannot drift from the dataclass.
- `main.py` serves `GET /embeddings/{evaluation_id}/{document_id}` from
  `proc/{evaluationId}/{documentId}.embeddings.json` and returns the Result-shaped
  `NOT_FOUND` body on a missing key — the same error taxonomy the Thread 4 adapter
  already maps.
- `tests/test_embeddings_api.py` pins the join to `(source_hash, chunk_index)`,
  the declared `model`/`dimensions`, unit-norm vectors, and the absent-shard 404.
- Thread 20's contract test reads a **captured** payload fixture, pinning the
  contract on the TypeScript side, exactly as ADR-0003 does for extraction.
- `redline-domain` purity (check #4) keeps `IEmbeddingReader`'s DTOs
  dependency-free, so the vector can only ever be plain data.
