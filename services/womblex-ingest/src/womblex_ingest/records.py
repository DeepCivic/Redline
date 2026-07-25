"""The Parquet→JSON boundary — server side.

Thread 4 locks build-plan §8 decision #2 in favour of a **JSON seam**: the sidecar
(which already owns the heavy womblex/Parquet stack) reads its own Parquet shards
and serves them as JSON, so the TypeScript adapter never links a Parquet reader.

These dataclasses are the canonical wire shape. Field names are the JSON keys and
mirror `IProcurementExtractionReader`'s DTOs in `redline-domain` (camelCase), so the
Thread 4 TS adapter is a thin, allocation-only mapping. The womblex provenance keys
(`source_hash`, `elem_order`, `chunk_id`) are normalised into that vocabulary here,
at the one place that understands womblex's schema.

Thread 19 widens the seam to a second resource: `DocumentEmbeddings` carries
womblex's `*.embeddings.parquet` sibling as plain JSON float arrays (ADR-0014).
It is a sibling of `DocumentExtraction`, not a field on it, because the embed
stage is an optional overlay — the two resources are absent independently.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import List, Optional


@dataclass(frozen=True)
class ElementRecord:
    """A womblex element: `source_hash` → documentId, `elem_order` → elementOrder."""

    documentId: str
    elementOrder: int
    page: Optional[int]
    text: str


@dataclass(frozen=True)
class ChunkRecord:
    """A womblex chunk: chunkId is `{source_hash}:{chunk_index}`."""

    chunkId: str
    documentId: str
    text: str


@dataclass(frozen=True)
class TableCellRecord:
    """A currency-typed (or plain) table cell from `table_cells`/`sheet_cell`."""

    documentId: str
    elementOrder: int
    page: Optional[int]
    rowIndex: int
    columnIndex: int
    rawValue: str
    isCurrency: bool


@dataclass(frozen=True)
class DocumentExtraction:
    """The full read model for one document, as served over the JSON seam."""

    documentId: str
    elements: List[ElementRecord]
    chunks: List[ChunkRecord]
    tableCells: List[TableCellRecord]

    def to_json(self) -> dict:
        return {
            "documentId": self.documentId,
            "elements": [asdict(e) for e in self.elements],
            "chunks": [asdict(c) for c in self.chunks],
            "tableCells": [asdict(t) for t in self.tableCells],
        }


@dataclass(frozen=True)
class EmbeddingRecord:
    """One chunk's vector.

    `chunkId` is `"{source_hash}:{chunk_index}"` — the same join key
    `ChunkRecord` carries, so an embedding attaches to its chunk without a
    second vocabulary. `chunkIndex` repeats the ordinal explicitly so a consumer
    can join on `(source_hash, chunk_index)` without parsing the composite key.
    """

    chunkId: str
    chunkIndex: int
    values: List[float]


@dataclass(frozen=True)
class DocumentEmbeddings:
    """One document's vectors, as served over the JSON seam (ADR-0014).

    A sibling of `DocumentExtraction`, never a field on it: the embed stage is an
    optional overlay, so a document may have an extraction and no embeddings.
    Build via `make_document_embeddings` — the boundary's guarantees (unit-norm
    vectors, a truthful `dimensions`) are construction-time, not conventional.
    """

    documentId: str
    model: str
    dimensions: int
    vectors: List[EmbeddingRecord]

    def to_json(self) -> dict:
        return {
            "documentId": self.documentId,
            "model": self.model,
            "dimensions": self.dimensions,
            "vectors": [asdict(v) for v in self.vectors],
        }


def make_document_embeddings(
    *, document_id: str, model: str, vectors: List[EmbeddingRecord]
) -> DocumentEmbeddings:
    """Build the wire model, normalising the vectors and deriving `dimensions`.

    Raises on producer misuse only — a payload that cannot be matched against is
    worse than an absent one, because it fails silently as bad classifications
    rather than loudly at the seam.
    """
    if not model.strip():
        raise ValueError("embeddings must declare the model that produced them")
    if not vectors:
        raise ValueError(
            "embeddings must carry at least one vector; a document with no chunks "
            "has no embeddings shard, which is the NOT_FOUND path"
        )

    dimensions = len(vectors[0].values)
    if any(len(vector.values) != dimensions for vector in vectors):
        raise ValueError("every vector must have the same number of dimensions")

    chunk_ids = [vector.chunkId for vector in vectors]
    if len(set(chunk_ids)) != len(chunk_ids):
        raise ValueError("one vector per chunk: duplicate chunkId")

    return DocumentEmbeddings(
        documentId=document_id,
        model=model.strip(),
        dimensions=dimensions,
        vectors=[
            EmbeddingRecord(
                chunkId=vector.chunkId,
                chunkIndex=vector.chunkIndex,
                values=_l2_normalised(vector.values),
            )
            for vector in vectors
        ],
    )


def _l2_normalised(values: List[float]) -> List[float]:
    """Unit-length the vector so a consumer's cosine similarity is a dot product."""
    magnitude = math.sqrt(sum(value * value for value in values))
    if magnitude == 0:
        raise ValueError("a zero-magnitude vector cannot be normalised or matched")
    return [value / magnitude for value in values]
