"""The womblex table-cell feed the financial worker reads.

Build plan §6: the worker reads womblex ``table_cells`` / ``sheet_cell`` /
``form_fields`` (currency-typed) **for a topic's already-deduped matched chunks**.
In the vendored fork (Thread 16) that feed is Numbatch's own ingestion store —
the same chunk Parquet Numbatch classified, keyed on ``source_doc_id`` and the
matched chunk ids. Here we express it as a small :class:`WomblexSource` protocol
so the worker depends only on the seam, and provide an in-memory fake so the
stage is provable standalone (no MinIO, no GPU — ADR-0005).

``MatchedTopic`` is the per-topic slice of a batch-inference roll-up: the topic a
document matched and, in the fork, its deduped matched chunk ids. The protocol
hides how those chunks resolve to womblex cells so the worker never links a
Parquet/S3 reader.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from .extractor import MatchedCell


@dataclass(frozen=True)
class MatchedTopic:
    """A topic a document matched, with its deduped matched chunk ids.

    ``chunk_ids`` are ``{source_hash}:{chunk_index}`` values (empty in the
    standalone fake, which keys cells by ``(source_doc_id, topic_id)`` directly).
    """

    topic_id: str
    chunk_ids: tuple[str, ...] = field(default=())


class WomblexSource(Protocol):
    """Reads a topic's matched womblex cells and a description fallback."""

    async def currency_cells(
        self, source_doc_id: str, topic: MatchedTopic
    ) -> list[MatchedCell]:
        """The table cells of ``topic``'s matched chunks for this document."""

    async def fallback_text(self, source_doc_id: str, topic: MatchedTopic) -> str:
        """Prose used when no currency cell was matched (build plan §1)."""


class FakeWomblexSource:
    """In-memory ``WomblexSource`` for standalone tests.

    Keyed on ``(source_doc_id, topic_id)`` — the fork's implementation resolves
    the same slice through Numbatch's ingestion store and the roll-up's matched
    chunk ids.
    """

    def __init__(
        self,
        cells: dict[tuple[str, str], list[MatchedCell]],
        fallbacks: dict[tuple[str, str], str],
    ) -> None:
        self._cells = cells
        self._fallbacks = fallbacks

    async def currency_cells(
        self, source_doc_id: str, topic: MatchedTopic
    ) -> list[MatchedCell]:
        return self._cells.get((source_doc_id, topic.topic_id), [])

    async def fallback_text(self, source_doc_id: str, topic: MatchedTopic) -> str:
        return self._fallbacks.get(
            (source_doc_id, topic.topic_id),
            f"No costing figure was matched for topic {topic.topic_id}.",
        )
