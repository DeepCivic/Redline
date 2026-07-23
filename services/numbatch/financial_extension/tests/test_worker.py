"""Worker tests — the Thread 7 exit test.

A synthetic tender workbook (womblex table cells) + a batch-inference roll-up
(which topics each document matched, and their matched chunks) → the worker
writes ``financial_extractions`` rows with currency-normalised figures and
provenance, one per (document, requirement), no duplication.

The womblex feed is an in-memory fake (``FakeWomblexSource``) so the whole stage
is provable standalone — no MinIO, no GPU, no vendored fork (ADR-0005; same
posture as Thread 5's captured payload and Thread 6's SQLite overlay).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from numbatch_financial.extraction_repository import FinancialExtractionRepository
from numbatch_financial.extractor import MatchedCell
from numbatch_financial.models import Base, FinancialProfile, LineItemGranularity
from numbatch_financial.womblex_source import FakeWomblexSource, MatchedTopic
from numbatch_financial.worker import extract_financials_for_document


@pytest_asyncio.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


async def _seed_profile(
    factory: async_sessionmaker[AsyncSession],
    topic_id: str,
    granularity: LineItemGranularity = LineItemGranularity.BUNDLE,
) -> str:
    async with factory() as session:
        profile = FinancialProfile(
            topic_id=topic_id,
            name=f"Costs for {topic_id}",
            target_currency="AUD",
            granularity=granularity,
        )
        session.add(profile)
        await session.flush()
        await session.commit()
        return profile.id


async def test_synthetic_workbook_yields_figures_with_provenance(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_profile(session_factory, "t-support")

    # A synthetic tender workbook: the support topic matched a chunk whose table
    # cells carry two currency figures (a bundle) at known elem_orders.
    source = FakeWomblexSource(
        cells={
            ("82f9355e", "t-support"): [
                MatchedCell(elem_order=7, raw_value="$1,200.50", is_currency=True),
                MatchedCell(elem_order=9, raw_value="$300.00", is_currency=True),
            ],
        },
        fallbacks={("82f9355e", "t-support"): "Annual support & SLA"},
    )

    await extract_financials_for_document(
        session_factory=session_factory,
        womblex_source=source,
        source_doc_id="82f9355e",
        matched_topics=[MatchedTopic(topic_id="t-support")],
    )

    async with session_factory() as session:
        rows = await FinancialExtractionRepository(session).list_for_doc("82f9355e")

    assert len(rows) == 1
    figure = rows[0]
    assert figure.topic_id == "t-support"
    assert float(figure.amount) == 1500.50
    assert figure.currency == "AUD"
    assert figure.source_elem_order == 7
    assert figure.description == "Annual support & SLA"


async def test_topic_with_no_currency_cell_writes_description_fallback(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_profile(session_factory, "t-support")
    source = FakeWomblexSource(
        cells={
            ("5c1a7be0", "t-support"): [
                MatchedCell(elem_order=4, raw_value="POA", is_currency=False),
            ],
        },
        fallbacks={("5c1a7be0", "t-support"): "Priced on application."},
    )

    await extract_financials_for_document(
        session_factory=session_factory,
        womblex_source=source,
        source_doc_id="5c1a7be0",
        matched_topics=[MatchedTopic(topic_id="t-support")],
    )

    async with session_factory() as session:
        rows = await FinancialExtractionRepository(session).list_for_doc("5c1a7be0")

    assert len(rows) == 1
    assert rows[0].amount is None
    assert rows[0].description == "Priced on application."


async def test_one_figure_per_matched_topic_no_duplication(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _seed_profile(session_factory, "t-support")
    await _seed_profile(session_factory, "t-residency")
    source = FakeWomblexSource(
        cells={
            ("82f9355e", "t-support"): [
                MatchedCell(elem_order=7, raw_value="$1,200.50", is_currency=True),
            ],
            ("82f9355e", "t-residency"): [
                MatchedCell(elem_order=12, raw_value="$980.00", is_currency=True),
            ],
        },
        fallbacks={},
    )
    matched = [MatchedTopic(topic_id="t-support"), MatchedTopic(topic_id="t-residency")]

    # Running twice must not duplicate — the (source_doc_id, topic_id) invariant.
    await extract_financials_for_document(
        session_factory=session_factory,
        womblex_source=source,
        source_doc_id="82f9355e",
        matched_topics=matched,
    )
    await extract_financials_for_document(
        session_factory=session_factory,
        womblex_source=source,
        source_doc_id="82f9355e",
        matched_topics=matched,
    )

    async with session_factory() as session:
        rows = await FinancialExtractionRepository(session).list_for_doc("82f9355e")

    assert {row.topic_id for row in rows} == {"t-support", "t-residency"}
    assert len(rows) == 2


async def test_topics_without_a_financial_profile_are_skipped(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Only t-support is configured for financial extraction; t-vendor is not.
    await _seed_profile(session_factory, "t-support")
    source = FakeWomblexSource(
        cells={
            ("82f9355e", "t-support"): [
                MatchedCell(elem_order=7, raw_value="$1,200.50", is_currency=True),
            ],
            ("82f9355e", "t-vendor"): [
                MatchedCell(elem_order=3, raw_value="$50.00", is_currency=True),
            ],
        },
        fallbacks={},
    )

    await extract_financials_for_document(
        session_factory=session_factory,
        womblex_source=source,
        source_doc_id="82f9355e",
        matched_topics=[
            MatchedTopic(topic_id="t-support"),
            MatchedTopic(topic_id="t-vendor"),
        ],
    )

    async with session_factory() as session:
        rows = await FinancialExtractionRepository(session).list_for_doc("82f9355e")

    assert [row.topic_id for row in rows] == ["t-support"]
