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


class RealWomblexExtractor:
    def extract(self, evaluation_id: str, document_names: List[str]) -> ExtractionResult:
        # Shape once the womblex Python API is wired:
        #   1. run womblex over `document_names` → Parquet shards
        #   2. read those shards and build `DocumentExtraction` per source_hash
        #      (records.py), normalising elem_order / chunk_id / currency cells
        #   3. return ExtractionResult(shards=..., documents=...)
        raise NotImplementedError(
            "Real womblex extraction is not yet wired: the Parquet→JSON mapping is "
            "pinned (see records.py) but the concrete womblex call surface is "
            "pending. Run with WOMBLEX_MODE=stub until then."
        )
