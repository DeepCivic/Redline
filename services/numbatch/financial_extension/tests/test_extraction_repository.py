"""Extraction repository tests — the write side of the Thread 7 worker.

Proves the ``(source_doc_id, topic_id)`` no-duplication invariant (build plan §6)
is enforced by the repository's upsert, not left to the caller: re-running the
worker for the same (document, requirement) updates the one row rather than
raising on the unique constraint or writing a duplicate.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from numbatch_financial.extraction_repository import (
    ExtractionFigure,
    FinancialExtractionRepository,
)
from numbatch_financial.models import Base, FinancialProfile


@pytest_asyncio.fixture()
async def session() -> AsyncIterator[AsyncSession]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as open_session:
        yield open_session
    await engine.dispose()


async def _profile(session: AsyncSession, topic_id: str = "topic-support") -> str:
    profile = FinancialProfile(
        topic_id=topic_id,
        name="Support & SLA costs",
        target_currency="AUD",
    )
    session.add(profile)
    await session.flush()
    return profile.id


async def test_upsert_writes_a_figure_with_provenance(session: AsyncSession) -> None:
    profile_id = await _profile(session)

    stored = await FinancialExtractionRepository(session).upsert(
        source_doc_id="82f9355e",
        topic_id="topic-support",
        financial_profile_id=profile_id,
        figure=ExtractionFigure(
            amount=1200.50,
            currency="AUD",
            description="Annual support fee",
            source_elem_order=7,
        ),
    )
    await session.commit()

    assert stored.source_doc_id == "82f9355e"
    assert stored.topic_id == "topic-support"
    assert float(stored.amount) == 1200.50
    assert stored.currency == "AUD"
    assert stored.source_elem_order == 7


async def test_upsert_is_idempotent_per_doc_topic(session: AsyncSession) -> None:
    profile_id = await _profile(session)
    repository = FinancialExtractionRepository(session)

    first = await repository.upsert(
        source_doc_id="82f9355e",
        topic_id="topic-support",
        financial_profile_id=profile_id,
        figure=ExtractionFigure(amount=1000.00, currency="AUD", description="v1"),
    )
    await session.commit()
    second = await repository.upsert(
        source_doc_id="82f9355e",
        topic_id="topic-support",
        financial_profile_id=profile_id,
        figure=ExtractionFigure(amount=1200.50, currency="AUD", description="v2"),
    )
    await session.commit()

    # One row for the (document, requirement) pair — re-extraction updates it.
    assert second.id == first.id
    assert float(second.amount) == 1200.50
    assert second.description == "v2"

    rows = await repository.list_for_doc("82f9355e")
    assert len(rows) == 1


async def test_upsert_stores_description_fallback_with_null_amount(
    session: AsyncSession,
) -> None:
    profile_id = await _profile(session)

    stored = await FinancialExtractionRepository(session).upsert(
        source_doc_id="5c1a7be0",
        topic_id="topic-support",
        financial_profile_id=profile_id,
        figure=ExtractionFigure(
            amount=None,
            currency=None,
            description="Priced on application; see section 4.",
            source_elem_order=None,
        ),
    )
    await session.commit()

    assert stored.amount is None
    assert stored.currency is None
    assert stored.description == "Priced on application; see section 4."
