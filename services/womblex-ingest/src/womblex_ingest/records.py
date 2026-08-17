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
    """A womblex chunk: chunkId is `{source_hash}:{chunk_index}`.

    `startChar`/`endChar`/`elementOrder` are the element range this chunk was cut
    from (delivery-plan "Chunk element addressing"), mirroring womblex's own
    CHUNKS_SCHEMA (store/output.py): a narrative chunk carries startChar/endChar
    (offsets into the reassembled narrative, the coordinate space a money span's
    narrative locus reads) and null elementOrder; a table chunk carries
    elementOrder (the table element it was cut from — null for a
    spreadsheet-sheet table chunk, which has no single anchor element) and null
    startChar/endChar (its offsets are into table markdown, not narrative).
    """

    chunkId: str
    documentId: str
    text: str
    contentType: str = "narrative"
    startChar: Optional[int] = None
    endChar: Optional[int] = None
    elementOrder: Optional[int] = None


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
