"""Real womblex extractor — Thread 37b, the binding behind the seam.

The **womblex engine** (the `womblex` compose profile, which builds the engine's
own image from the `services/womblex` submodule) runs the real pipeline
(`extract` → `chunk` → `embed`) and lands its Parquet shards in object storage
under `proc/{evaluationId}/` — the redline-owned bucket, whatever backs it.
This module is the *binding*: with `WOMBLEX_MODE=real` it reads those
engine-produced shards from object storage and maps womblex's
schema into the JSON read model (`records.py`), so the TypeScript adapter never
links a Parquet reader. The pod owns the durable Parquet;
the binding only *reads* it — hence `ExtractionResult.shards` is empty here
(re-writing shards the pod already wrote would duplicate the record).

Why read the engine's shards rather than invoke womblex in-process: the seam is
object storage, so the sidecar and the engine stay *separately
deployable and freely co-locatable* — neither imports the other, which is what
lets the engine be a version-pinned submodule swapped without relinking the
sidecar. womblex's runtime (PyMuPDF, OCR, the Kanon tokeniser, model weights) is
also heavier than this API layer, so keeping the coupling to storage means the
sidecar image stays light whether or not the engine is deployed beside it. The
production orchestration of the worker (one-shot, scaled fleet, or co-located)
is then a free deployment choice.

The schema mapping itself lives in `shard_reader.py` (the one place that
understands `source_hash` / `elem_order` / `chunk_index` / currency cells),
kept separate so it is provable with plain row dicts — no pyarrow or womblex
install needed for the mapping tests. This module supplies the rows by decoding
the Parquet, and delegates.

`pyarrow` (the Parquet decode) is imported lazily so `pip install` of the base
API package stays light; it is pulled by the `.[womblex]` extra and only
touched under `WOMBLEX_MODE=real`.
"""

from __future__ import annotations

import io
import re
from typing import Dict, List, Optional, Sequence

from womblex_ingest.extraction import ExtractionResult
from womblex_ingest.shard_reader import (
    Row,
    ShardSchemaError,
    group_rows_by_document,
    map_document_extraction,
)
from womblex_ingest.storage import ObjectStorage

# The womblex shard-name suffixes the engine writes. We discover shards by
# suffix rather than by an assumed run-directory name, because the batch/run
# segment is womblex's, not ours.
_ELEMENTS_SUFFIX = ".elements.parquet"
_CHUNKS_SUFFIX = ".chunks.parquet"
_TABLE_CELLS_SUFFIX = ".table_cells.parquet"

# The engine lands every run under `proc/{evaluationId}/runs/<run_id>/documents/`
# (womblex `store/retention.py`). A key without that segment is the flat legacy
# layout, which we read as a single implicit run so the earliest corpora still
# ingest. `run_id` is captured so shards can be grouped by run and one selected.
_RUN_SEGMENT = re.compile(r"/runs/(?P<run_id>[^/]+)/")
_NO_RUN = ""


class RealWomblexExtractor:
    """Reads the womblex pod's Parquet shards from MinIO and serves them as JSON.

    Constructed with the same `ObjectStorage` the API writes JSON through, plus
    the bucket, so the real lane reads exactly the shards the pod produced. The
    `document_names` argument is advisory: womblex keys by `source_hash`, so the
    binding serves every document present under the evaluation's prefix and the
    read seams look them up by `documentId` (a `source_hash`).
    """

    def __init__(self, storage: ObjectStorage, bucket: str) -> None:
        self._storage = storage
        self._bucket = bucket

    def extract(
        self,
        evaluation_id: str,
        document_names: List[str],
        run_id: Optional[str] = None,
    ) -> ExtractionResult:
        prefix = f"proc/{evaluation_id}/"
        keys = self._storage.list_objects(prefix)
        all_parquet_keys = [key for key in keys if key.endswith(".parquet")]
        parquet_keys = self._select_run(all_parquet_keys, evaluation_id, run_id)

        elements = self._read_shards(parquet_keys, _ELEMENTS_SUFFIX)
        chunks = self._read_shards(parquet_keys, _CHUNKS_SUFFIX)
        table_cells = self._read_shards(parquet_keys, _TABLE_CELLS_SUFFIX)

        documents_rows = group_rows_by_document(
            elements=elements,
            chunks=chunks,
            table_cells=table_cells,
        )

        documents = [map_document_extraction(rows) for rows in documents_rows]

        return ExtractionResult(
            document_count=len(documents),
            # The pod owns the durable Parquet; the binding does not re-write it.
            shards=[],
            documents=documents,
        )

    def _select_run(
        self,
        parquet_keys: Sequence[str],
        evaluation_id: str,
        run_id: Optional[str],
    ) -> List[str]:
        """Narrow the evaluation's shards to exactly one run's worth.

        Multiple runs land under one evaluation prefix, so reading them all merges
        every `source_hash` once per run — `elementOrder` repeats and the chunk
        store doubles on the next ingest. Group by run and pick one: the explicit
        `run_id` if given, else the latest. Run ids are `run-YYYYMMDDTHHMMSSZ`, so
        the lexicographically-greatest id is the most recent (womblex
        `retention.most_recent_run` sorts the same way).
        """
        by_run: Dict[str, List[str]] = {}
        for key in parquet_keys:
            match = _RUN_SEGMENT.search(key)
            by_run.setdefault(match.group("run_id") if match else _NO_RUN, []).append(key)

        if run_id is not None:
            selected = by_run.get(run_id)
            if not selected:
                raise ShardSchemaError(
                    f"no womblex Parquet shards for run {run_id!r} under "
                    f"proc/{evaluation_id}/: check the run id, or omit it to read the "
                    "latest run"
                )
            return selected

        if not by_run:
            # No shards under the prefix means the womblex pod has not run for this
            # evaluation (or ran elsewhere). Fail loudly: an empty ExtractionResult
            # would masquerade as "extracted, found nothing", a different and
            # misleading state.
            raise ShardSchemaError(
                f"no womblex Parquet shards under proc/{evaluation_id}/: run the "
                "womblex pod (the `womblex` compose profile) for this evaluation "
                "before ingesting in real mode"
            )
        latest_run = max(by_run)
        return by_run[latest_run]

    def _read_shards(self, parquet_keys: Sequence[str], suffix: str) -> List[Row]:
        rows: List[Row] = []
        for key in parquet_keys:
            if key.endswith(suffix):
                rows.extend(_read_parquet_rows(self._storage.get_object(key)))
        return rows


def _read_parquet_rows(body: bytes) -> List[Row]:
    """Decode one Parquet shard's rows into plain dicts.

    Isolated (and pyarrow imported here, not at module top) so the schema mapping
    in `shard_reader` — and its tests — need neither pyarrow nor a real shard.
    """
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    table = pq.read_table(io.BytesIO(body))
    return table.to_pylist()
