"""Real womblex extractor — invokes the actual womblex pipeline.

Isolated in its own module and imported lazily (see `extraction.build_extractor`)
so `pip install womblex` (and, optionally, Isaacus) is only required when
`WOMBLEX_MODE=real`. The stub path carries the Thread 3 exit test and the
air-gapped mode.

Thread 4 pins the Parquet→JSON boundary this extractor must honour: after running
womblex it reads the emitted Parquet shards (`*.elements.parquet`,
`*.chunks.parquet`, `*.table_cells.parquet`) and maps womblex's provenance keys
(`source_hash`, `elem_order`, `chunk_id`, currency cells) into the `records.py`
dataclasses (`ElementRecord` / `ChunkRecord` / `TableCellRecord`), returning them
on `ExtractionResult.documents` alongside the durable shards. That mapping is the
one place that understands womblex's schema; everything downstream sees JSON.

The concrete womblex call surface is still being finalised, so running with
`WOMBLEX_MODE=real` fails loudly rather than emitting empty or stub data.
"""

from __future__ import annotations

from typing import List

from womblex_ingest.extraction import ExtractionResult
from womblex_ingest.records import QueryEmbedding


class RealWomblexExtractor:
    def extract(self, evaluation_id: str, document_names: List[str]) -> ExtractionResult:
        # Shape once the womblex Python API is wired:
        #   1. run womblex over `document_names` → Parquet shards
        #   2. read those shards and build `DocumentExtraction` per source_hash
        #      (records.py), normalising elem_order / chunk_id / currency cells
        #   3. read the `*.embeddings.parquet` siblings and build
        #      `DocumentEmbeddings` via `make_document_embeddings`, joining each
        #      vector to its chunk on (source_hash, chunk_index) and declaring the
        #      model womblex's embed stage used (ADR-0014). Documents whose embed
        #      stage did not run are simply omitted — an absent shard is NOT_FOUND,
        #      not an empty payload.
        #   4. return ExtractionResult(shards=..., documents=..., embeddings=...)
        raise NotImplementedError(
            "Real womblex extraction is not yet wired: the Parquet→JSON mapping is "
            "pinned (see records.py) but the concrete womblex call surface is "
            "pending. Run with WOMBLEX_MODE=stub until then."
        )


class RealWomblexTextEmbedder:
    """Embeds arbitrary text via womblex's embed operation (ADR-0014, Thread 20a).

    The query counterpart of `RealWomblexExtractor`: it must embed text with the
    *same* model womblex's embed stage used for chunk vectors, and declare that
    model, or Thread 22's nearest-neighbour ranks noise. Still pending, so it
    fails loudly rather than returning a stub vector in a real deployment.
    """

    def embed(self, text: str) -> QueryEmbedding:
        # Shape once the womblex embed surface is wired:
        #   1. call womblex's embed(text) with the corpus's embed-stage model
        #   2. build the wire model via `make_query_embedding`, declaring that
        #      model so a consumer can confirm it matches the chunk vectors'.
        raise NotImplementedError(
            "Real womblex text embedding is not yet wired: it must share the model "
            "womblex's embed stage uses for chunk vectors (ADR-0014). Run with "
            "WOMBLEX_MODE=stub until then."
        )
