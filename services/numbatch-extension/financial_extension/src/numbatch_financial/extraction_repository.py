"""Async write access for financial extractions — the Thread 7 worker's output.

The one place the worker touches the ``financial_extractions`` ORM, kept separate
from the extraction logic (``extractor.py``) so that logic stays pure and this
stays a thin persistence seam.

``upsert`` enforces the no-duplication invariant (build plan §6) in code rather
than relying on the caller to check first: it looks up the existing row for the
``(source_doc_id, topic_id)`` pair and updates it in place, so re-running the
worker over the same (document, requirement) never writes a duplicate and never
trips ``uq_financial_extractions_doc_topic``.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import FinancialExtraction


@dataclass(frozen=True)
class ExtractionFigure:
    """One extracted monetary fact, or a description-only fallback.

    ``amount``/``currency`` are ``None`` when only a prose description of costs
    was available ("dollar estimate OR a short description" — build plan §1);
    ``description`` is always populated. ``source_elem_order`` is provenance back
    to womblex's ``elem_order`` for the matched cell, ``None`` for a fallback.
    """

    amount: float | None
    currency: str | None
    description: str
    source_elem_order: int | None = None


class FinancialExtractionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_doc_topic(
        self, source_doc_id: str, topic_id: str
    ) -> FinancialExtraction | None:
        result = await self._session.execute(
            select(FinancialExtraction).where(
                FinancialExtraction.source_doc_id == source_doc_id,
                FinancialExtraction.topic_id == topic_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_for_doc(self, source_doc_id: str) -> list[FinancialExtraction]:
        result = await self._session.execute(
            select(FinancialExtraction)
            .where(FinancialExtraction.source_doc_id == source_doc_id)
            .order_by(FinancialExtraction.topic_id)
        )
        return list(result.scalars().all())

    async def upsert(
        self,
        source_doc_id: str,
        topic_id: str,
        financial_profile_id: str,
        figure: ExtractionFigure,
    ) -> FinancialExtraction:
        existing = await self.get_by_doc_topic(source_doc_id, topic_id)
        if existing is not None:
            existing.financial_profile_id = financial_profile_id
            existing.amount = figure.amount
            existing.currency = figure.currency
            existing.description = figure.description
            existing.source_elem_order = figure.source_elem_order
            await self._session.flush()
            await self._session.refresh(existing)
            return existing

        extraction = FinancialExtraction(
            source_doc_id=source_doc_id,
            topic_id=topic_id,
            financial_profile_id=financial_profile_id,
            amount=figure.amount,
            currency=figure.currency,
            description=figure.description,
            source_elem_order=figure.source_elem_order,
        )
        self._session.add(extraction)
        await self._session.flush()
        await self._session.refresh(extraction)
        return extraction
