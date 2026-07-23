"""Async data access for financial profiles.

A thin repository over SQLAlchemy's async session — the one place the config API
touches the ORM. Kept separate from the router so the router stays a thin
HTTP-to-Result mapping and the repository is unit-testable against SQLite.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import FinancialProfile
from .schemas import FinancialProfileCreate


class FinancialProfileRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_topic(self, topic_id: str) -> FinancialProfile | None:
        result = await self._session.execute(
            select(FinancialProfile).where(FinancialProfile.topic_id == topic_id)
        )
        return result.scalar_one_or_none()

    async def get_by_id(self, profile_id: str) -> FinancialProfile | None:
        return await self._session.get(FinancialProfile, profile_id)

    async def list_all(self) -> list[FinancialProfile]:
        result = await self._session.execute(
            select(FinancialProfile).order_by(FinancialProfile.created_at)
        )
        return list(result.scalars().all())

    async def create(self, payload: FinancialProfileCreate) -> FinancialProfile:
        profile = FinancialProfile(
            topic_id=payload.topic_id,
            name=payload.name,
            description=payload.description,
            target_currency=payload.target_currency,
            cost_basis=payload.cost_basis,
            granularity=payload.granularity,
        )
        self._session.add(profile)
        await self._session.flush()
        await self._session.refresh(profile)
        return profile
