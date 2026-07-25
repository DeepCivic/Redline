# Thread 20a — Sidecar text-embedding endpoint

**Status:** ✅ Complete · **Date:** 2026-07-25 · **Version intent:** MINOR (pre-1.0; additive route on an existing service, no existing behaviour changed)

Design entry: [`docs/comprehension-lens-design.md` §6 · Track L](../comprehension-lens-design.md)
· surfaced by [ADR-0014](../adr/0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) (Consequences → Negative)
· **blocks Thread 22** (retrieval classification); **needs nothing from Thread 20**

## Goal

Give the retrieval stage a **query vector**. Thread 19 ships one vector per
*chunk*; Thread 22 matches a topic *definition* against those chunks, and
redline's TypeScript links no embedding model. So the sidecar — which already owns
chunk embedding — must also embed arbitrary text, in the **same space** as the
chunk vectors, or nearest-neighbour ranks noise.

**Exit test:** pytest embeds text and gets a vector whose `model` and `dimensions`
match the document embeddings' declaration; the same text embeds identically
twice.

## Why this is its own thread, and why it blocks 22 not 20

ADR-0014 recorded the gap in its own Consequences: *"shipping vectors does not by
itself give Thread 22 a comparable query vector … the sidecar still owes a
text-embedding endpoint … It is **Thread 20a**, a sidecar thread blocking Thread
22 — not Thread 20, which reads document vectors and needs nothing from it."*

- **Not folded into Thread 20.** Thread 20 is a TypeScript adapter reading
  *document* vectors; bolting a Python endpoint onto it would cross both a package
  and a language boundary, breaking the thread contract.
- **Not folded into Thread 19.** Thread 19's exit gate is the document read seam;
  this is a distinct resource with a distinct shape (chunk-free, no join key).
- **A property of the model, not the corpus.** A query vector is comparable to a
  chunk vector only when it declares the *same* model and dimensionality and is
  L2-normalised the same way. That constraint is what this thread encodes.

## What was built

All of it in `services/womblex-ingest` — one service, no TypeScript touched.

### New — `src/womblex_ingest/embedding.py`

| Symbol | Contents |
|---|---|
| `TextEmbedder` (Protocol) | `embed(text) -> QueryEmbedding`. The seam the query route depends on, mirroring `Extractor`. |
| `StubTextEmbedder` | Deterministic, dependency-free, in the stub extractor's *same* space (`STUB_EMBEDDING_MODEL`, `STUB_EMBEDDING_DIMENSIONS`). Trims surrounding whitespace, then hashes via the shared scheme. |
| `_deterministic_vector(text, dimensions)` | The one hashing scheme both chunk and query vectors use — `sha256("embedding|{key}")`, mapped into `[-1, 1]^n`. The chunk embedder keys on `chunk_id`, a query on its text, so both land in one space. |
| `build_text_embedder(mode)` | `real` → lazily imported `RealWomblexTextEmbedder`; otherwise the stub. Mirrors `build_extractor`. |

The chunk embedder in `extraction.py` was refactored to route through this shared
`_deterministic_vector`, keyed on `chunk_id` exactly as before — verified
**byte-for-byte identical** so the Thread 20 captured fixture
(`redline-adapters/.../embeddings-tender.pdf.json`) does not drift.

### Modified — `src/womblex_ingest/records.py`

`QueryEmbedding` (`model`, `dimensions`, `values`) + `to_json`, and its only
constructor `make_query_embedding`. Same construction-time guarantees as
`make_document_embeddings` — blank model, no values, and zero-magnitude are
rejected at the seam — minus the per-chunk join, because a query is chunk-free.
The shared `_l2_normalised` is now used by both constructors.

### Modified — `src/womblex_ingest/main.py`

```
POST /embeddings/query
  { "text": "network security controls" }
  → 200 { "model": "stub-deterministic-v1", "dimensions": 8, "values": [0.37, …] }
  → 422 { "error": { "code": "INVALID_REQUEST", "message": "text must not be empty" } }
```

`build_app` gains an optional `embedder`, defaulting to `StubTextEmbedder()` so the
app starts (and the exit test passes) with no womblex dependency — the same
default posture as the stub extractor. `build_app_from_env` wires
`build_text_embedder(WOMBLEX_MODE)`. The new route's path shape
(`/embeddings/query`, one segment) does not collide with the document route
(`/embeddings/{evaluation_id}/{document_id}`, two segments).

### Modified — `src/womblex_ingest/real_extractor.py`

`RealWomblexTextEmbedder` added beside `RealWomblexExtractor`, same posture: its
`embed` docstring pins the mapping (call womblex's embed op with the corpus's
embed-stage model, declare that model) and it raises `NotImplementedError` until
the concrete womblex surface is wired.

## Exit-test evidence

```
$ python -m pytest -q
66 passed in 0.21s
```

47 pre-existing tests still green, **19 new** (9 API + 10 embedder/wire model).
Against the exit test specifically:

| Exit criterion | Covered by |
|---|---|
| embeds text and gets a **vector** | `test_query_embedding_api.py::test_query_embedding_returns_a_vector` — 200, `len(values) == dimensions` |
| `model` **and** `dimensions` **match the document embeddings' declaration** | `…::test_query_embedding_declares_the_same_model_as_document_vectors` — reads `/embeddings/{eval}/{doc}` and asserts `query.model == document.model` and `query.dimensions == document.dimensions` |
| **the same text embeds identically twice** | `…::test_the_same_text_embeds_identically_twice`, and `test_stub_text_embedder.py::test_stub_embedder_is_deterministic` |

Beyond the stated criterion, because they are boundary promises ADR-0014 makes:
the query vector crosses L2-normalised (`test_query_vector_crosses_the_boundary_l2_normalised`),
lives in the same dimensionality as the chunk vectors
(`test_query_vector_lives_in_the_same_space_as_the_chunk_vectors`), different text
embeds differently, blank/missing text is `INVALID_REQUEST` (422), and the query
seam needs no prior ingest (a definition is embedded before a corpus is mapped).
`test_stub_text_embedder.py` pins every `make_query_embedding` rejection and
whitespace-insensitivity.

`./validate.sh` — **12/12 PASS, Failed: 0.**

### Real-request proof

Same environment limitation as Thread 19 — no container runtime — so the real
ASGI app was served in-process (only the MinIO seam faked) and driven over the
`TestClient` HTTP surface:

```
doc model/dims : stub-deterministic-v1 8
query response : {'model':'stub-deterministic-v1','dimensions':8,
                  'values':[0.3776…, 0.5391…, -0.2731…, …]}
same model     : True
same dims      : True
L2 norm        : 1.0
identical twice: True
blank text     : 422 INVALID_REQUEST
```

The query vector declares the identical `model`/`dimensions` the document vectors
do, is unit-norm, and is stable across calls — the exit criterion, end to end.
**The compose-level proof remains owed** alongside Thread 19's (limitation 7
there), to be added once a container runtime is available.

## Design decisions

No new ADR. This thread *implements* the gap ADR-0014 already recorded and named,
and settles nothing that was open. Two choices worth carrying forward:

- **One hashing scheme, two keys.** Rather than a second, unrelated stub space,
  the chunk embedder and the query embedder share `_deterministic_vector` — chunks
  key on `chunk_id`, queries on text. This keeps "same space" true by construction
  and made the byte-for-byte fixture stability trivial to verify. It is still a
  *stub* space, not a semantic one (Thread 19 limitation 6); it proves the seam,
  not retrieval quality.
- **Chunk-free wire shape.** `QueryEmbedding` deliberately omits `chunkId` /
  `documentId`. A query is not a document resource and is never persisted, so
  giving it a join key it can't honour would be a lie at the seam.

## Known limitations / follow-ups

1. **Real mode still raises.** `RealWomblexTextEmbedder.embed` pins the mapping in
   its docstring only — it must embed with the *same* model womblex's embed stage
   used for chunk vectors, and the concrete womblex call surface is still pending,
   exactly as for `RealWomblexExtractor` since Thread 4.
2. **The stub space is not semantic.** Thread 22's fixture corpus will want an
   embedding space with enough structure that nearest-neighbour is meaningful; the
   stub's 8 hashed dimensions rank arbitrarily. This is inherited from Thread 19
   (limitation 6), not introduced here.
3. **No model-match enforcement on the consumer yet.** The seam *declares* the
   model so Thread 20/22 can refuse a mismatch, but nothing downstream checks it
   until Thread 22 builds the matcher. The declaration is the enabling half; the
   refusal is Thread 22's.
4. **The compose-up proof is owed**, shared with Thread 19 limitation 7.
