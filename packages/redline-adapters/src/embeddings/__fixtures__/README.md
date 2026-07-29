# womblex embedding-reader fixtures

`embeddings-tender.pdf.json` is a **real capture** of the womblex-ingest sidecar's
retrieval read seam (ADR-0014) — the body of

```
GET /embeddings/eval-9/{documentId}
```

after `POST /ingest {evaluationId: "eval-9", documentNames: ["tender.pdf"]}` against
the deterministic stub extractor (`WOMBLEX_MODE=stub`). It is the contract the
`WomblexEmbeddingReader` maps into the domain's `DocumentEmbeddings` (vectors parsed
into `Float32Array`, joinable on `chunkId`).

It is a **sibling** of `../../womblex/__fixtures__/extraction-tender.pdf.json`: the
`documentId` (`82f9355e…`) and the `chunkId` (`82f9355e…:0`) are identical to that
extraction capture, because a chunk's embedding attaches to its chunk on the same
`{source_hash}:{chunk_index}` key. The vectors cross L2-normalised and declare the
producing `model` (`stub-deterministic-v1`) and `dimensions` (8).

## Regenerating

From `services/womblex-ingest` (with `src` on `PYTHONPATH`; the stub uses only the
standard library, so no extras are needed for this shape):

```python
import json
from womblex_ingest.extraction import StubWomblexExtractor

result = StubWomblexExtractor().extract("eval-9", ["tender.pdf"])
print(json.dumps(result.embeddings[0].to_json(), indent=2))
```

## `query-embedding.json`

A capture of the sidecar's **query** seam (ADR-0014) — the body of

```
POST /embeddings/query  {"text": "network security controls"}
```

against the deterministic stub text embedder. It is the contract the
`WomblexTextEmbedder` maps into the domain's `QueryEmbedding` (`values` parsed
into `Float32Array`). It is chunk-free — a query is never persisted and carries no
join key — and declares the *same* `model`/`dimensions` as the chunk vectors and
crosses L2-normalised, which is what lets Thread 22 rank chunks against a topic
definition by dot product.

Regenerate from `services/womblex-ingest`:

```python
import json
from womblex_ingest.embedding import StubTextEmbedder

print(json.dumps(StubTextEmbedder().embed("network security controls").to_json(), indent=2))
```
