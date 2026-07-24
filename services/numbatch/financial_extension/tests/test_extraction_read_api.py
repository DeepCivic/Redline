"""Extraction read-API tests — the Thread 8 read seam.

The Thread 7 worker writes ``financial_extractions``; the Thread 8 adapter
(``NumbatchFinancialExtractor``) needs to *read* them over HTTP to fill
``ProcurementResponse.costing``. This exercises the additive
``GET /financial-extractions/{source_doc_id}`` endpoint that serves one
document's extractions as JSON, mirroring the config API's style + error shape.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from numbatch_financial.api import build_app
from numbatch_financial.extraction_repository import (
    ExtractionFigure,
    FinancialExtractionRepository,
)
from numbatch_financial.models import Base, FinancialProfile


@pytest_asyncio.fixture()
async def session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        await engine.dispose()


@pytest.fixture()
def client(session_factory: async_sessionmaker[AsyncSession]) -> TestClient:
    async def get_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    return TestClient(build_app(get_session))


async def _seed_extraction(
    factory: async_sessionmaker[AsyncSession],
    *,
    source_doc_id: str,
    topic_id: str,
    figure: ExtractionFigure,
) -> None:
    async with factory() as session:
        profile = FinancialProfile(
            topic_id=topic_id, name=f"{topic_id} costs", target_currency="AUD"
        )
        session.add(profile)
        await session.flush()
        await FinancialExtractionRepository(session).upsert(
            source_doc_id=source_doc_id,
            topic_id=topic_id,
            financial_profile_id=profile.id,
            figure=figure,
        )
        await session.commit()


async def test_read_extractions_for_a_document(
    client: TestClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    await _seed_extraction(
        session_factory,
        source_doc_id="82f9355e",
        topic_id="t-support",
        figure=ExtractionFigure(
            amount=1500.50,
            currency="AUD",
            description="Annual support fee",
            source_elem_order=7,
        ),
    )

    response = client.get("/financial-extractions/82f9355e")

    assert response.status_code == 200
    body = response.json()
    assert body["source_doc_id"] == "82f9355e"
    assert len(body["extractions"]) == 1
    extraction = body["extractions"][0]
    assert extraction["topic_id"] == "t-support"
    assert extraction["amount"] == "1500.50"
    assert extraction["currency"] == "AUD"
    assert extraction["description"] == "Annual support fee"
    assert extraction["source_elem_order"] == 7


async def test_read_returns_all_extractions_for_the_document(
    client: TestClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    await _seed_extraction(
        session_factory,
        source_doc_id="82f9355e",
        topic_id="t-support",
        figure=ExtractionFigure(1500.50, "AUD", "Support", 7),
    )
    await _seed_extraction(
        session_factory,
        source_doc_id="82f9355e",
        topic_id="t-data-residency",
        figure=ExtractionFigure(None, None, "Priced on application", None),
    )

    response = client.get("/financial-extractions/82f9355e")

    assert response.status_code == 200
    topics = {row["topic_id"] for row in response.json()["extractions"]}
    assert topics == {"t-support", "t-data-residency"}


async def test_read_description_fallback_has_null_amount(
    client: TestClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    await _seed_extraction(
        session_factory,
        source_doc_id="5c1a7be0",
        topic_id="t-support",
        figure=ExtractionFigure(None, None, "Priced on application; see section 4.", None),
    )

    response = client.get("/financial-extractions/5c1a7be0")

    assert response.status_code == 200
    extraction = response.json()["extractions"][0]
    assert extraction["amount"] is None
    assert extraction["currency"] is None
    assert extraction["source_elem_order"] is None
    assert extraction["description"] == "Priced on application; see section 4."


async def test_read_unknown_document_is_empty_not_404(client: TestClient) -> None:
    # A document with no extractions is a valid empty result, not an error — the
    # adapter treats "no figures yet" as an empty costing set, not a failure.
    response = client.get("/financial-extractions/never-ingested")

    assert response.status_code == 200
    assert response.json() == {"source_doc_id": "never-ingested", "extractions": []}
