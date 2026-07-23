"""Real womblex extractor — invokes the actual womblex pipeline.

Isolated in its own module and imported lazily (see `extraction.build_extractor`)
so `pip install womblex` (and, optionally, Isaacus) is only required when
`WOMBLEX_MODE=real`. The stub path carries the Thread 3 exit test and the
air-gapped mode; wiring the concrete womblex call surface is finished alongside
the Thread 4 Parquet boundary, where the real shard schema is pinned down.
"""

from __future__ import annotations

from typing import List

from womblex_ingest.extraction import ExtractionResult


class RealWomblexExtractor:
    def extract(self, evaluation_id: str, document_names: List[str]) -> ExtractionResult:
        # womblex's Python API is finalised with the Thread 4 Parquet boundary;
        # until then, running with WOMBLEX_MODE=real fails loudly rather than
        # silently emitting stub data.
        raise NotImplementedError(
            "Real womblex extraction is wired in Thread 4 (Parquet boundary). "
            "Run with WOMBLEX_MODE=stub until then."
        )
