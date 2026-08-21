# womblex asset-reader fixtures

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
