"""The financial extraction worker stage (Thread 7).

The new Arq worker stage (build plan §6): for each topic a document matched,
read womblex's currency-typed table cells for that topic's already-deduped
matched chunks, extract a figure (or a description fallback), and upsert one
``financial_extractions`` row keyed on ``(source_doc_id, topic_id)`` — one figure
per (document, requirement), no duplication.

``extract_financials_for_document`` is the pure orchestration, wired only to a
:class:`~numbatch_financial.womblex_source.WomblexSource` seam and a session
factory, so it is provable standalone. ``financial_extraction_task`` is the Arq
entrypoint the fork registers on its worker (Thread 16): it resolves the seam
from the shared ``ctx`` and delegates here.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .extraction_repository import FinancialExtractionRepository
from .extractor import extract_figure
from .models import FinancialProfile
from .womblex_source import MatchedTopic, WomblexSource


async def _profiles_by_topic(
    session: AsyncSession, topic_ids: Sequence[str]
) -> dict[str, FinancialProfile]:
    if not topic_ids:
        return {}
    result = await session.execute(
        select(FinancialProfile).where(FinancialProfile.topic_id.in_(topic_ids))
    )
    return {profile.topic_id: profile for profile in result.scalars().all()}


async def extract_financials_for_document(
    session_factory: async_sessionmaker[AsyncSession],
    womblex_source: WomblexSource,
    source_doc_id: str,
    matched_topics: Sequence[MatchedTopic],
) -> None:
    """Write one financial extraction per matched, financially-configured topic.

    Topics without a live ``financial_profile`` are skipped — a topic is only
    financially extracted when the specialist configured it (Thread 6 config
    API). All writes for the document commit in a single transaction.
    """

    async with session_factory() as session:
        profiles = await _profiles_by_topic(
            session, [topic.topic_id for topic in matched_topics]
        )
        repository = FinancialExtractionRepository(session)

        for topic in matched_topics:
            profile = profiles.get(topic.topic_id)
            if profile is None:
                continue

            cells = await womblex_source.currency_cells(source_doc_id, topic)
            fallback = await womblex_source.fallback_text(source_doc_id, topic)
            figure = extract_figure(profile, cells, fallback)

            await repository.upsert(
                source_doc_id=source_doc_id,
                topic_id=topic.topic_id,
                financial_profile_id=profile.id,
                figure=figure,
            )

        await session.commit()


async def financial_extraction_task(
    ctx: dict[str, Any],
    source_doc_id: str,
    matched_topics: list[dict[str, Any]],
) -> None:
    """Arq entrypoint — registered on the fork's worker (Thread 16).

    ``ctx`` carries the shared ``session_factory`` and ``womblex_source`` the
    fork's ``WorkerSettings.on_startup`` wires up. The roll-up's matched topics
    arrive as plain dicts over Redis and are rehydrated into ``MatchedTopic``.
    """

    topics = [
        MatchedTopic(
            topic_id=entry["topic_id"],
            chunk_ids=tuple(entry.get("chunk_ids", ())),
        )
        for entry in matched_topics
    ]
    await extract_financials_for_document(
        session_factory=ctx["session_factory"],
        womblex_source=ctx["womblex_source"],
        source_doc_id=source_doc_id,
        matched_topics=topics,
    )
