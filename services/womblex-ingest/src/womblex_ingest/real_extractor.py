"""Real womblex extractor — Thread 37b, the binding behind the seam.

The **womblex engine** (the `womblex` compose profile, which builds the engine's
own image from the `services/womblex` submodule — ADR-0015) runs the real pipeline
(`extract` → `chunk` → `embed`) and lands its Parquet shards in object storage
under `proc/{evaluationId}/` — the redline-owned bucket, whatever backs it
(ADR-0002). This module is the *binding*: with `WOMBLEX_MODE=real` it reads those
engine-produced shards from object storage and maps womblex's
schema into the JSON read model (`records.py`), so the TypeScript adapter never
links a Parquet reader (ADR-0003 / ADR-0014). The pod owns the durable Parquet;
the binding only *reads* it — hence `ExtractionResult.shards` is empty here
(re-writing shards the pod already wrote would duplicate the record).

Why read the engine's shards rather than invoke womblex in-process: the seam is
object storage (ADR-0002), so the sidecar and the engine stay *separately
deployable and freely co-locatable* — neither imports the other, which is what
lets the engine be a version-pinned submodule swapped without relinking the
sidecar. womblex's runtime (PyMuPDF, OCR, the Kanon tokeniser, model weights) is
also heavier than this API layer, so keeping the coupling to storage means the
sidecar image stays light whether or not the engine is deployed beside it. The
production orchestration of the worker (one-shot, scaled fleet, or co-located)
is then a free deployment choice.

The schema mapping itself lives in `shard_reader.py` (the one place that
understands `source_hash` / `elem_order` / `chunk_index` / currency cells / the
`(source_hash, chunk_index)` embedding join), kept separate so it is provable
with plain row dicts — no pyarrow or womblex install needed for the mapping
tests. This module supplies the rows by decoding the Parquet, and delegates.

`pyarrow` (the Parquet decode) and `womblex` (the query embedder) are imported
lazily so `pip install` of the base API package stays light; both are pulled by
the `.[womblex]` extra and only touched under `WOMBLEX_MODE=real`.
"""

from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from womblex_ingest.extraction import ExtractionResult
from womblex_ingest.records import QueryEmbedding, make_query_embedding
from womblex_ingest.shard_reader import (
    Row,
    ShardSchemaError,
    group_rows_by_document,
    map_document_embeddings,
    map_document_extraction,
)
from womblex_ingest.storage import ObjectStorage

# The womblex shard-name suffixes the engine writes (see `architecture.md` §4 and
# ADR-0008). We discover shards by suffix rather than by an assumed run-directory
# name, because the batch/run segment is womblex's, not ours.
_ELEMENTS_SUFFIX = ".elements.parquet"
_CHUNKS_SUFFIX = ".chunks.parquet"
_TABLE_CELLS_SUFFIX = ".table_cells.parquet"
_EMBEDDINGS_SUFFIX = ".embeddings.parquet"

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
        embeddings, models_by_source_hash = self._read_embedding_shards(parquet_keys)

        documents_rows = group_rows_by_document(
            elements=elements,
            chunks=chunks,
            table_cells=table_cells,
            embeddings=embeddings,
            models_by_source_hash=models_by_source_hash,
        )

        documents = [map_document_extraction(rows) for rows in documents_rows]
        document_embeddings = [
            mapped
            for rows in documents_rows
            if (mapped := map_document_embeddings(rows)) is not None
        ]

        return ExtractionResult(
            document_count=len(documents),
            # The pod owns the durable Parquet; the binding does not re-write it.
            shards=[],
            documents=documents,
            embeddings=document_embeddings,
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

    def _read_embedding_shards(
        self, parquet_keys: Sequence[str]
    ) -> Tuple[List[Row], Dict[str, str]]:
        """Read embedding rows and the model each document's vectors declare.

        womblex's embed stage records the model on the shard (a column, or the
        file's key/value metadata); we surface it per `source_hash` so the
        mapping can declare it (ADR-0014). A shard with no embed stage simply
        contributes no rows — the NOT_FOUND path, resolved per document
        downstream.
        """
        rows: List[Row] = []
        models_by_source_hash: Dict[str, str] = {}
        for key in parquet_keys:
            if not key.endswith(_EMBEDDINGS_SUFFIX):
                continue
            body = self._storage.get_object(key)
            table_model = _read_parquet_model(body)
            for row in _read_parquet_rows(body):
                rows.append(row)
                source_hash = row.get("source_hash") or row.get("source_doc_id")
                declared = row.get("model") or table_model
                if source_hash is not None and declared:
                    models_by_source_hash[str(source_hash)] = str(declared)
        return rows, models_by_source_hash


# womblex's own DEFAULT_TASK is "retrieval/document" — the *index* side. A query
# must be embedded with the query task or it lands in a different space from the
# chunk vectors it is ranked against, which degrades silently rather than failing
# (womblex `analyse/embed.py`: "Isaacus task types matter").
QUERY_TASK = "retrieval/query"

# Where the deployment's womblex config lives, when the sidecar is given one. The
# engine and the sidecar must agree on the embed model, so the model is read from
# womblex's own config rather than restated here (see `_resolve_embedding_model`).
_CONFIG_PATH_ENV = "WOMBLEX_CONFIG"


@dataclass(frozen=True)
class QueryEmbedStage:
    """womblex's embed call, bound to a client and the chunk vectors' model.

    Isolating the engine seam as data makes the binding's contract — one text, the
    query task, the declared model — testable without installing womblex or
    holding an Isaacus key, and keeps the lazy import in exactly one place.
    """

    embed_texts: Callable[..., List[List[float]]]
    client: object
    model: str


def load_womblex_query_embed_stage(config_path: Optional[str] = None) -> QueryEmbedStage:
    """Bind womblex's real embed call. Imports womblex — real mode only."""
    from womblex.analyse.embed import embed_texts  # type: ignore[import-not-found]
    from womblex.cli._shared import make_isaacus_client  # type: ignore[import-not-found]

    return QueryEmbedStage(
        embed_texts=embed_texts,
        client=make_isaacus_client(),
        model=_resolve_embedding_model(config_path or os.environ.get(_CONFIG_PATH_ENV)),
    )


def _resolve_embedding_model(config_path: Optional[str]) -> str:
    """The embed model from womblex's own configuration — never a second copy.

    With a config path, the deployment's actual `embedding.model` (the same file
    the womblex worker runs with, mounted at `infra/womblex/redline.yaml`). Without
    one, womblex's own declared default. Either way the value originates upstream,
    so a self-consistent deployment cannot drift chunks into model A and queries
    into model B — the one mismatch retrieval refuses.
    """
    from womblex.config import EmbeddingConfig, load_config  # type: ignore[import-not-found]

    if not config_path:
        return EmbeddingConfig().model
    return load_config(Path(config_path)).embedding.model


class RealWomblexTextEmbedder:
    """Embeds arbitrary text via womblex's embed operation (ADR-0014).

    The query counterpart of `RealWomblexExtractor`: it must embed text with the
    *same* model womblex's embed stage used for chunk vectors, or Thread 22's
    nearest-neighbour ranking is noise.
    """

    def __init__(self, stage: Optional[QueryEmbedStage] = None) -> None:
        # NOT resolved here. `build_text_embedder("real")` runs during app
        # start-up, and the read seam ships as a womblex-FREE image by design
        # (architecture.md §1), so binding the engine in __init__ made query
        # embedding fatal to boot — the sidecar died on ModuleNotFoundError
        # before serving a single extraction read. Query similarity search is
        # deferred anyway (ADR-0018 addendum), so the capability this needs must
        # not gate the one it does not.
        self._stage = stage

    def _resolve_stage(self) -> QueryEmbedStage:
        if self._stage is None:
            self._stage = load_womblex_query_embed_stage()
        return self._stage

    def embed(self, text: str) -> QueryEmbedding:
        stage = self._resolve_stage()
        vectors = stage.embed_texts(
            [text],
            stage.client,
            model=stage.model,
            task=QUERY_TASK,
        )
        if not vectors:
            raise ValueError(
                "womblex returned no vector for the query text; a topic that cannot "
                "be embedded cannot be matched against chunk vectors (ADR-0014)"
            )
        # `make_query_embedding` declares the model and L2-normalises so a
        # query·chunk dot product is well-formed; a producer that already
        # normalised pays only an idempotent second pass.
        return make_query_embedding(
            model=stage.model,
            values=[float(value) for value in vectors[0]],
        )


def _read_parquet_rows(body: bytes) -> List[Row]:
    """Decode one Parquet shard's rows into plain dicts.

    Isolated (and pyarrow imported here, not at module top) so the schema mapping
    in `shard_reader` — and its tests — need neither pyarrow nor a real shard.
    """
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    table = pq.read_table(io.BytesIO(body))
    return table.to_pylist()


def _read_parquet_model(body: bytes) -> Optional[str]:
    """Read the embed-stage model from a shard's file-level metadata, if declared.

    womblex may record the model as a column (handled per row) or in the file's
    key/value metadata; this reads the metadata fallback. Absent → ``None``, and
    the mapping then relies on a per-row `model` column, or refuses (a payload a
    consumer cannot confirm is worse than an absent one).
    """
    import pyarrow.parquet as pq  # type: ignore[import-not-found]

    metadata = pq.read_metadata(io.BytesIO(body)).metadata or {}
    for raw_key, raw_value in metadata.items():
        key = raw_key.decode() if isinstance(raw_key, bytes) else str(raw_key)
        if key in ("model", "embedding_model", "embed_model"):
            return raw_value.decode() if isinstance(raw_value, bytes) else str(raw_value)
    return None
