"""The text-embedding seam — server side (ADR-0014).

Thread 19 ships one vector per chunk. Retrieval also needs the topic
*definition* embedded into the same space to match against those chunks, and
redline's TypeScript links no embedding model — so the sidecar owns query
embedding too, exactly as it owns chunk embedding.

`TextEmbedder` is the protocol the query route depends on. Two implementations:

- `StubTextEmbedder` — deterministic, dependency-free, in the *same* space the
  `StubWomblexExtractor` puts chunk vectors (same model id, same dimensions). It
  is what the exit test and air-gapped runs use.
- `RealWomblexTextEmbedder` — calls womblex's embed operation on raw text.
  Imported lazily and still pending, mirroring `RealWomblexExtractor`.

A query vector is comparable to a chunk vector only when it declares the *same*
model and dimensionality and is L2-normalised the same way. That the two stub
embedders agree on `STUB_EMBEDDING_MODEL` / `STUB_EMBEDDING_DIMENSIONS` is the
whole point of the seam — a mismatch would rank noise (ADR-0014).
"""

from __future__ import annotations

import hashlib
from typing import List, Protocol

from womblex_ingest.records import QueryEmbedding, make_query_embedding


class TextEmbedder(Protocol):
    def embed(self, text: str) -> QueryEmbedding: ...


class StubTextEmbedder:
    """Deterministic text embedder in the stub extractor's vector space.

    Uses the *same* hashing scheme `StubWomblexExtractor` uses for chunk vectors,
    keyed on the (whitespace-trimmed) text rather than a chunk id, so the same
    definition always embeds to the same vector — the stability a captured
    fixture and content-addressed reuse both rely on.
    """

    def embed(self, text: str) -> QueryEmbedding:
        # Imported here rather than at module top to avoid a circular import:
        # `extraction` imports `records`, and the stub constants live there.
        from womblex_ingest.extraction import (
            STUB_EMBEDDING_DIMENSIONS,
            STUB_EMBEDDING_MODEL,
        )

        return make_query_embedding(
            model=STUB_EMBEDDING_MODEL,
            values=_deterministic_vector(text.strip(), STUB_EMBEDDING_DIMENSIONS),
        )


def _deterministic_vector(text: str, dimensions: int) -> List[float]:
    """The stub embedding of `text`: the same scheme chunk vectors use.

    Chunk vectors hash `"embedding|{chunk_id}"`; a query hashes
    `"embedding|{text}"`. Both land in the same [-1, 1]^n cube and are then
    L2-normalised by `make_query_embedding`, so a query·chunk dot product is
    well-formed. The stub space is not semantically meaningful (Thread 19,
    limitation 6) — it exists to prove the seam, not to retrieve well.
    """
    digest = hashlib.sha256(f"embedding|{text}".encode()).digest()
    return [(byte - 127.5) / 127.5 for byte in digest[:dimensions]]


def build_text_embedder(mode: str) -> TextEmbedder:
    if mode == "real":
        # Imported lazily so `pip install womblex` is only required in real mode.
        from womblex_ingest.real_extractor import RealWomblexTextEmbedder

        return RealWomblexTextEmbedder()
    return StubTextEmbedder()
