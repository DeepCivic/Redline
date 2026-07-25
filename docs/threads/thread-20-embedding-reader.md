# Thread 20 — `IEmbeddingReader` port + adapter

**Status:** ✅ Complete · **Date:** 2026-08-06 · **Version intent:** MINOR (pre-1.0; new domain port + new adapter surface, additive, no existing behaviour changed)

Design entry: [`docs/comprehension-lens-design.md` §6 · Track L](../comprehension-lens-design.md)
· rests on [ADR-0014](../adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) (settled, precondition — no new ADR)
· consumes Thread 19's [sidecar embeddings endpoint](./thread-19-sidecar-embeddings-endpoint.md)
· unblocks Thread 22 (retrieval classification) — together with Thread 20a (the query-vector endpoint)

## Goal

Read the womblex sidecar's `*.embeddings.parquet` sibling — served as JSON floats
over `GET /embeddings/{evaluationId}/{documentId}` (Thread 19, ADR-0014) — into a
TypeScript domain port, so the lens's retrieval stage (Thread 22) has vectors to
match against without any trained model.

**Exit test:** contract test against a captured sidecar payload; error taxonomy
covered; TypeScript still links no Parquet reader.

## The decision this thread rests on

Thread 20 was **not** gated on a new ADR. [ADR-0014](../adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md)
(settled as Thread 19's precondition) already fixes the wire, and it does two
things that bind *this* thread specifically, because redline is cloud-hosted:

- **Parse into `Float32Array`, not `number[]`.** JavaScript numbers are 64-bit; a
  boxed array is ~2–3× the resident memory for precision cosine similarity cannot
  use. Under a container memory limit that is the difference between ~60 MB and
  ~160 MB at procurement scale.
- **Cache per evaluation.** Extraction output is immutable and content-addressed,
  so a document's vectors never change: the transfer is payable **once per
  evaluation**, not once per classification run. Without the cache the cloud
  economics genuinely favour server-side retrieval (the rejected alternative).

Both are treated as requirements here, not optimisations, and each has a test.

## What was built

Two packages, one seam, one commit — within the thread contract.

### New — `packages/redline-domain/src/ports/embedding-reader.ts`

| Symbol | Contents |
|---|---|
| `ChunkEmbedding` (`chunkId`, `chunkIndex`, `values: Float32Array`) | One chunk's vector. `chunkId` is `"{source_hash}:{chunk_index}"` — the same join key the extraction port speaks — and `chunkIndex` carries the ordinal explicitly so a consumer joins without parsing the composite key. `values` is a `Float32Array` (ADR-0014). |
| `DocumentEmbeddings` (`documentId`, `model`, `dimensions`, `vectors`) | One document's vectors. `model` is load-bearing: vectors from different models are incomparable, so Thread 22 must embed topic definitions in the same space or refuse. |
| `IEmbeddingReader.readEmbeddings(evaluationId, documentId)` | Returns `Promise<Result<DocumentEmbeddings>>`. A document with no embed stage (or an air-gapped deployment) yields `NOT_FOUND` — a legitimate outcome, not a broken extraction. |

`Float32Array` is a JavaScript built-in, so the DTO stays plain data and
`redline-domain` keeps its zero-dependency purity (check #4 green). A 2-test
port-conformance suite (`embedding-reader.test.ts`) pins the shape with an
in-memory fake, exactly as `ports.test.ts` does for the Thread 2/4 ports.

### New — `packages/redline-adapters/src/embeddings/`

- `womblex-embedding-reader.ts` — `WomblexEmbeddingReader implements IEmbeddingReader`
  over an injected `HttpClient` (a `fetch`-shaped GET seam; no global fetch, no
  Parquet/S3 client). Reads one document-scoped payload, narrows it, and **caches
  the successful result keyed on `(evaluationId, documentId)`**. A failed read is
  not cached, so a transient outage can be retried.
- `wire.ts` — the one place that trusts the wire and narrows `unknown` →
  `DocumentEmbeddings`, parsing each `number[]` into a `Float32Array` and rejecting
  a vector whose length disagrees with the declared `dimensions` (an unmatchable
  vector is worse than an absent one — it fails silently downstream). Maps the
  sidecar's Result-shaped errors: `NOT_FOUND` passes through; other read failures →
  `EXTRACTION_FAILED`; transport/parse failures → `INFRA_FAILURE` /
  `EXTRACTION_FAILED`. Nothing throws across the port edge.
- `__fixtures__/embeddings-tender.pdf.json` (+ `README.md`) — a **real capture** of
  the sidecar's stub-extractor response, a sibling of the Thread 4 extraction
  fixture: the same `documentId` and `chunkId`, so the two join.

Exported from `redline-adapters`'s `index.ts` as `WomblexEmbeddingReader` (+ its
`HttpClient`/`HttpResponse`/options types).

## Exit-test evidence

```
@redline/redline-domain:test  ✓ src/ports/embedding-reader.test.ts (2 tests)
                              Tests  97 passed (97)     [was 95; +2]
@redline/redline-adapters:test ✓ src/embeddings/womblex-embedding-reader.test.ts (12 tests)
```

Against the stated exit criterion:

| Exit criterion | Covered by |
|---|---|
| **contract test against a captured sidecar payload** | `womblex-embedding-reader.test.ts` reads `__fixtures__/embeddings-tender.pdf.json` — a real capture — into `DocumentEmbeddings`; `values` is a `Float32Array` of `dimensions` length, the `chunkId` decomposes into `(source_hash, chunk_index)`, and the vector stays L2-normalised across the parse |
| **error taxonomy covered** | `NOT_FOUND` (sidecar 404 body) · `INFRA_FAILURE` (transport throw) · `EXTRACTION_FAILED` (malformed values, dimension mismatch, non-JSON body) — none throw |
| **TypeScript still links no Parquet reader** | the adapter reads JSON over an injected `HttpClient`; `redline-domain` purity check #4 stays green |

Beyond the stated criterion, because ADR-0014 makes them binding: the per-`(evaluation,
document)` cache means immutable vectors are fetched **once** (`urls` has length 1
across two reads), distinct documents/evaluations are not conflated (3 reads → 3
fetches), and a failed read is not cached (retry succeeds).

`./validate.sh` — **12/12 PASS, Failed: 0.**

## Design decisions

No new ADR — the thread rests on ADR-0014. Choices worth recording:

- **`Float32Array` lives in the domain DTO.** It is a JS built-in, not an external
  dependency, so `redline-domain` stays zero-dep while the memory constraint is
  expressed at the type the port returns — the consumer cannot accidentally hold
  `number[]`.
- **The cache is on the adapter, keyed on `(evaluationId, documentId)`.** Vectors
  are immutable and content-addressed (ADR-0014), so a hit is safe for the reader's
  lifetime. Only successful reads are cached; the domain port is unaware of the
  cache.
- **Dimension disagreement is rejected at the seam.** A vector whose length ≠ the
  declared `dimensions` is unmatchable; failing at the boundary beats bad
  classifications three threads later — the same posture as the sidecar's
  construction-time guards (Thread 19).
- **The wire module mirrors the Thread 4 extraction reader's `wire.ts`** — one
  narrowing point, Result-shaped error mapping, a captured fixture pinning the
  contract on both sides.

## Known limitations / follow-ups

1. **Thread 22 still needs a query vector — Thread 20a.** This adapter reads
   *document* vectors; matching topic definitions against them needs those
   definitions embedded in the same space, which redline's TypeScript cannot do.
   That is Thread 20a (a sidecar text-embedding endpoint), Thread 22's dependency,
   not this one's — Thread 20 needs nothing from it (ADR-0014, Thread 19 limitation 1).
2. **The cache is per-reader-instance and unbounded.** Correct for an evaluation's
   lifetime (the reader is wired per request/evaluation in the container), but a
   long-lived reader over many evaluations would grow without eviction. Bound it if
   a single reader is ever shared across evaluations.
3. **No live sidecar run here** (no container runtime in this build environment —
   same posture as Threads 5–19). The contract is pinned against a captured payload
   on the TS side and against `test_embeddings_api.py` on the Python side; a
   compose-up round trip lands with the other owed service proofs (Thread 16 /
   when a runtime is available).
4. **The stub's 8 dimensions are not a real embedding space** (Thread 19
   limitation 6). Thread 22's fixture corpus will want enough dimensionality that
   nearest-neighbour is meaningful.
