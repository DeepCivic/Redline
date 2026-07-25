# Thread 19 — Sidecar embeddings read endpoint

**Status:** ✅ Complete · **Date:** 2026-07-25 · **Version intent:** MINOR (pre-1.0; additive resource on an existing service, no existing behaviour changed)

Design entry: [`docs/comprehension-lens-design.md` §6 · Track L](../comprehension-lens-design.md)
· locks [ADR-0014](../adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) (precondition)
· amends [ADR-0003](../adr/0003-parquet-to-json-boundary.adr.md)
· closes design-doc §9 open question #1
· unblocks Thread 20 (`IEmbeddingReader`)

## Goal

Serve womblex's `*.embeddings.parquet` sibling over the JSON boundary, so the
lens's retrieval stage has vectors to match against — the point at which the
workflow first becomes demonstrable with no trained model (design doc §6,
"Sequencing").

**Exit test:** pytest reads real vectors for a document, joinable on
`(source_hash, chunk_index)`; absent shard → `NOT_FOUND`.

## The decision this thread was gated on

Thread 19's scope was to *settle* the vector wire format — design-doc §9 open
question #1 — so the ADR was a **precondition**, drafted and approved before any
code, per the `/build` gate. Three options were on the table: JSON float arrays, a
binary side channel, or keeping retrieval server-side in the sidecar and shipping
only neighbours.

[ADR-0014](../adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md)
takes **JSON float arrays on a sibling document-scoped resource**. Two points
worth carrying forward, because both moved during review:

- The rejection of server-side retrieval rests on **Thread 22's exit-gate
  testability** (a fixture corpus classifies with no service, no network, no
  Python) and on iteration speed while the ambiguity thresholds are unmeasured —
  *not* on the architectural objection the first draft led with. The sidecar could
  take opaque `{id, text}` queries and never learn what a topic is, and
  classification policy stays in `redline-application` either way.
- redline is **cloud-hosted**, which makes two consumer-side constraints binding
  rather than advisory: parse into `Float32Array` (not `number[]`), and cache per
  evaluation. Vectors are immutable and content-addressed, so the transfer is
  payable once per evaluation, not once per run. Without the cache the cloud
  economics genuinely favour server-side retrieval.

## What was built

All of it in `services/womblex-ingest` — one service, no TypeScript touched.

### Modified — `src/womblex_ingest/records.py`

| Symbol | Contents |
|---|---|
| `EmbeddingRecord` (`chunkId`, `chunkIndex`, `values`) | One chunk's vector. `chunkId` is `"{source_hash}:{chunk_index}"` — the identity `ChunkRecord` already carries, so an embedding attaches to its chunk without a second vocabulary. `chunkIndex` repeats the ordinal so a consumer can join on the pair without parsing the composite key. |
| `DocumentEmbeddings` (`documentId`, `model`, `dimensions`, `vectors`) + `to_json` | The wire model. A **sibling** of `DocumentExtraction`, never a field on it. |
| `make_document_embeddings(...)` | The only constructor. L2-normalises every vector, derives `dimensions`, and rejects producer misuse: a blank model, no vectors, ragged dimensions, a duplicate `chunkId`, a zero-magnitude vector. |

The guarantees are construction-time on purpose. A payload that cannot be matched
against is worse than an absent one, because it fails silently as bad
classifications three threads downstream rather than loudly at the seam.

### Modified — `src/womblex_ingest/extraction.py`

`ExtractionResult` gains `embeddings: List[DocumentEmbeddings]`, defaulting to
empty — a run with no embed stage is a legitimate outcome, not a failure.
`StubWomblexExtractor` now emits an `*.embeddings.parquet` sibling shard per
document and a deterministic vector per chunk, derived from the chunk's own id so
the same content always embeds to the same vector (`STUB_EMBEDDING_MODEL =
"stub-deterministic-v1"`, 8 dimensions — small enough that a captured fixture
stays readable).

### Modified — `src/womblex_ingest/main.py`

`embeddings_key()` → `proc/{evaluationId}/{documentId}.embeddings.json`, written
on ingest beside the extraction JSON, and served by:

```
GET /embeddings/{evaluationId}/{documentId}
  → 200 { documentId, model, dimensions, vectors: [{ chunkId, chunkIndex, values }] }
  → 404 { "error": { "code": "NOT_FOUND", "message": … } }
```

Written in its **own loop** over `result.embeddings` rather than alongside the
extraction, which is what makes the two resources absent independently.

### Modified — `src/womblex_ingest/real_extractor.py`

The pending real-mode mapping now also pins the embeddings leg in its docstring:
read the `*.embeddings.parquet` siblings, join on `(source_hash, chunk_index)`,
declare womblex's model, and **omit** documents whose embed stage did not run.
Still `NotImplementedError` — the concrete womblex call surface remains pending,
exactly as for extraction.

## Exit-test evidence

```
$ python -m pytest -q
37 passed in 0.23s
```

17 pre-existing tests still green, 20 new. Against the exit test specifically:

| Exit criterion | Covered by |
|---|---|
| reads **real vectors** for a document | `test_embeddings_api.py::test_read_embeddings_serves_vectors_for_a_document` — 200, one vector per chunk, `len(values) == dimensions` |
| **joinable on `(source_hash, chunk_index)`** | `…::test_embeddings_join_the_extraction_chunks_on_source_hash_and_chunk_index` — the embeddings' `chunkId`s equal the extraction's, and each decomposes into `(documentId, chunkIndex)` |
| **absent shard → `NOT_FOUND`** | `…::test_read_embeddings_of_unknown_document_is_404`, and `…::test_embeddings_are_absent_independently_of_the_extraction` — extraction 200 while embeddings 404, the case that matters |

Beyond the stated criterion, because ADR-0014 makes them boundary promises:
vectors cross L2-normalised (`test_vectors_cross_the_boundary_l2_normalised`), the
model is declared (`test_read_embeddings_declares_the_producing_model`),
evaluations are isolated, and the nine `test_embedding_records.py` cases pin every
construction-time rejection. `test_stub_extractor.py` adds three: embeddings join
the stub's own chunks, the same chunk embeds identically across runs
(content-addressed), and different chunks embed differently.

`./validate.sh` — **11/11 PASS, Failed: 0.**

### Real-request proof

No container runtime is available in this build environment (`podman info` fails;
the Docker daemon is unreachable), so the compose-up proof the `/build` skill asks
of a service thread could not run. The next best thing did: the **real ASGI app
served by uvicorn over real HTTP**, with only the MinIO seam stood in by an
in-memory store. Routing, JSON serialisation, the stub womblex extractor and both
read seams are the production code path.

```
$ curl -XPOST :8019/ingest -d '{"evaluationId":"eval-19","documentNames":["tender.pdf"]}'
{"runId":"c702663b-…","status":"succeeded","documentCount":1,
 "shardKeys":["proc/eval-19/_manifest.parquet",
              "proc/eval-19/tender.pdf.elements.parquet",
              "proc/eval-19/tender.pdf.embeddings.parquet"]}

$ curl :8019/extractions/eval-19/9152985b1eac9b82
{"documentId":"9152985b1eac9b82", …, "chunks":[{"chunkId":"9152985b1eac9b82:0", …}]}

$ curl :8019/embeddings/eval-19/9152985b1eac9b82
{"documentId":"9152985b1eac9b82","model":"stub-deterministic-v1","dimensions":8,
 "vectors":[{"chunkId":"9152985b1eac9b82:0","chunkIndex":0,
             "values":[0.7148604199002508,-0.4266558237349323, … ]}]}

dimensions declared : 8 | values present: 8
L2 norm             : 1.0
join key            : 9152985b1eac9b82:0 -> (9152985b1eac9b82, 0)

$ curl -w '%{http_code}' :8019/embeddings/eval-19/nope
{"error":{"code":"NOT_FOUND","message":"no embeddings for document nope …"}} 404
```

The embeddings' `chunkId` is the extraction's `chunkId`, and it decomposes into
the `(source_hash, chunk_index)` pair the exit test names. **The compose-level
proof remains owed** — it should be added to `scripts/thread-03-smoke.sh`'s
pattern once a container runtime is available (see limitation 7).

## Design decisions

Recorded as [ADR-0014](../adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md).
In brief:

- **A sibling resource, not a field on `/extractions`.** The embed stage is an
  optional overlay; the two resources must be absent independently, which is what
  makes "absent shard → `NOT_FOUND`" a normal outcome rather than a broken
  extraction. It also keeps the Thread 4 adapter from paying megabytes for data it
  never reads.
- **`chunkId` is the join key**, because the seam already speaks it.
- **Plain `number[]`, not base64.** Keeps the wire plain data — no decode step, no
  endianness, inspectable with `curl`, and a readable fixture for Thread 20.
  Binary stays reachable additively via an `encoding` discriminator.
- **L2-normalised at the producer, model declared.** Cosine becomes a dot product
  downstream, and a consumer can refuse a mismatched vector space instead of
  silently ranking noise.

## Known limitations / follow-ups

1. **The sidecar owes a text-embedding endpoint — now Thread 20a.** Shipping
   chunk vectors does not by itself give Thread 22 a comparable *query* vector:
   topic definitions must be embedded in the same space, and redline's TypeScript
   has no model. This gap exists under the server-side alternative too, so it is a
   planning gap rather than a consequence of ADR-0014. It was first filed against
   Thread 20; that was wrong — Thread 20 reads document vectors and needs nothing
   from it, and bolting a Python endpoint onto a TS thread would break the thread
   contract. It is its own sidecar thread, blocking Thread 22. §6 and §10 updated.
2. **`Float32Array` + per-evaluation caching are unenforced here.** They are
   binding constraints on Thread 20 (ADR-0014), but nothing in this service can
   check them. If Thread 20 lands without the cache, the cloud economics of this
   decision stop holding.
3. **Real mode still raises.** The embeddings mapping is pinned in docstrings
   only, same posture as extraction since Thread 4.
4. **`content_type` is dropped** from womblex's three-part join key, since
   `ChunkRecord` does not carry it. Additive on *both* records if real shards need
   it.
5. **No corpus has been measured.** The re-entry condition in ADR-0014 (~50k
   chunks, or cross-region deployment) is a threshold nobody has tested against;
   the first real corpus should be measured rather than assumed to fit.
6. **The stub's 8 dimensions are not a real embedding space.** Deliberate — it
   keeps fixtures readable — but Thread 22's fixture corpus will want vectors with
   enough dimensionality that nearest-neighbour is meaningful.
7. **The compose-up proof is owed.** No container runtime exists in this build
   environment, so the "shards actually land in MinIO, served over the network"
   check that `scripts/thread-03-smoke.sh` performs for Thread 3 has no embeddings
   equivalent yet. The live-uvicorn run above covers the HTTP surface but stands
   in for MinIO; extending the smoke script is the follow-up.
