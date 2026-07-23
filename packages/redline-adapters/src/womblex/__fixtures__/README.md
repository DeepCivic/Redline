# womblex extraction-reader fixtures

`extraction-tender.pdf.json` is a **real capture** of the womblex-ingest sidecar's
Parquet→JSON read seam — the body of

```
GET /extractions/eval-9/{documentId}
```

after `POST /ingest {evaluationId: "eval-9", documentNames: ["tender.pdf"]}` against
the deterministic stub extractor (`WOMBLEX_MODE=stub`). It is the contract the
`WomblexExtractionReader` maps into the domain's typed provenance
(`ExtractionElement` / `ExtractionChunk` / `ExtractionTableCell`).

The `documentId` (`82f9355e…`) is a womblex-style `source_hash`; `chunkId` follows
`{source_hash}:{chunk_index}`; the table cell is currency-typed (`isCurrency: true`).

## Regenerating

From `services/womblex-ingest` (with the `[dev]` extras installed):

```python
import json
from fastapi.testclient import TestClient
from womblex_ingest.main import build_app
from womblex_ingest.extraction import StubWomblexExtractor
from womblex_ingest.storage import ObjectNotFound

class Mem:
    def __init__(self): self.o = {}
    def put_object(self, k, b, c): self.o[k] = b
    def get_object(self, k):
        try: return self.o[k]
        except KeyError as e: raise ObjectNotFound(k) from e

store = Mem()
client = TestClient(build_app(storage=store, extractor=StubWomblexExtractor(), bucket="redline"))
client.post("/ingest", json={"evaluationId": "eval-9", "documentNames": ["tender.pdf"]})
doc_id = next(k for k in store.o if k.endswith(".extraction.json")).split("/")[-1][: -len(".extraction.json")]
print(json.dumps(client.get(f"/extractions/eval-9/{doc_id}").json(), indent=2))
```
