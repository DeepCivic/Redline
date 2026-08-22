# womblex read-seam fixtures

`shard-pages.json` is a **real capture** of the womblex-ingest sidecar's
run-scoped shard route — the body of

```
GET /runs/throsby/run-throsby-demo/shards/{asset}
```

served from the committed real run at
`services/womblex-ingest/tests/fixtures/run-throsby-demo/`. It is the contract the
`WomblexAssetReader` narrows into the domain's `ShardPage`, verbatim — womblex's
own column names and values, unchanged.

It holds three pages:

- `elements_page_1` / `elements_page_2` — the run's 24 elements, `limit=20`, at
  `offset` 0 and 20, so a first page truncates (`returned: 20`) and a second
  continues where it stopped (`returned: 4`, `truncated: false`).
- `table_cells_empty` — an asset that exists but holds no rows, with its columns
  still reported, so "no rows" stays distinct from "no such asset".

## Regenerating

From `services/womblex-ingest` (with `pyarrow` available):

```python
import json, sys
from pathlib import Path
sys.path.insert(0, "tests")
from tests.conftest import FakeObjectStorage
from tests.test_shards import load_fixture_run
from womblex_ingest.shards import read_shard

storage = FakeObjectStorage()
load_fixture_run(storage)

out = {
    "elements_page_1": read_shard(storage, "throsby", "run-throsby-demo", "elements", limit=20, offset=0).to_json(),
    "elements_page_2": read_shard(storage, "throsby", "run-throsby-demo", "elements", limit=20, offset=20).to_json(),
    "table_cells_empty": read_shard(storage, "throsby", "run-throsby-demo", "table_cells").to_json(),
}
dest = Path("../../packages/redline-adapters/src/womblex/__fixtures__/shard-pages.json")
dest.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
```


---

# `corpus-shape.json`

A **real capture** of the sidecar's shape routes over the same committed run, at
all three scopes:

```
GET /runs/throsby/shape                                    -> "corpus"
GET /runs/throsby/run-throsby-demo/shape                   -> "run"
GET /runs/throsby/run-throsby-demo/shape?documentId={hash} -> "document"
```

Two runs are staged: `run-throsby-demo` in full, and an earlier
`run-20260101T000000Z` holding elements and manifest only. Runs of different shape
under one corpus is the case the corpus scope has to keep apart — in the older run
`entities` is *absent* rather than empty, and those two lead a client to opposite
next calls.

The three scopes minify to 2.6KB, 6.4KB and 8.6KB. The corpus scope is the small
one by design: it carries no column schemas, because "which runs exist and how big
are they" does not need twelve assets' worth of them.

## Regenerating

From `services/womblex-ingest` (with `pyarrow` available):

```python
import json, sys
from pathlib import Path
sys.path.insert(0, "tests")
from tests.conftest import FakeObjectStorage
from womblex_ingest.shape import read_shape

FIXTURE = Path("tests/fixtures/run-throsby-demo")
DOC = "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54"

storage = FakeObjectStorage()
for path in sorted(FIXTURE.rglob("*.parquet")):
    storage.put_object(f"proc/throsby/run-throsby-demo/{path.relative_to(FIXTURE).as_posix()}", path.read_bytes(), "application/octet-stream")
for path in sorted(FIXTURE.rglob("*.parquet")):
    if path.name.endswith(("elements.parquet", "_manifest.parquet")):
        storage.put_object(f"proc/throsby/run-20260101T000000Z/{path.relative_to(FIXTURE).as_posix()}", path.read_bytes(), "application/octet-stream")

out = {
    "corpus": read_shape(storage, "throsby").to_json(),
    "run": read_shape(storage, "throsby", run_id="run-throsby-demo").to_json(),
    "document": read_shape(storage, "throsby", run_id="run-throsby-demo", document_id=DOC).to_json(),
}
dest = Path("../../packages/redline-adapters/src/womblex/__fixtures__/corpus-shape.json")
dest.write_text(json.dumps(out, indent=2) + "\n")
```
