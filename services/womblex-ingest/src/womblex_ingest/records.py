"""The Parquet→JSON boundary — server side.

Thread 4 locks build-plan §8 decision #2 in favour of a **JSON seam**: the sidecar
(which already owns the heavy womblex/Parquet stack) reads its own Parquet shards
and serves them as JSON, so the TypeScript adapter never links a Parquet reader.

These dataclasses are the canonical wire shape. Field names are the JSON keys and
mirror `IProcurementExtractionReader`'s DTOs in `redline-domain` (camelCase), so the
Thread 4 TS adapter is a thin, allocation-only mapping. The womblex provenance keys
(`source_hash`, `elem_order`, `chunk_id`) are normalised into that vocabulary here,
at the one place that understands womblex's schema.
"""

from __future__ import annotations

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
