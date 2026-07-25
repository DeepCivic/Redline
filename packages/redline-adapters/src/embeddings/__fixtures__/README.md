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
