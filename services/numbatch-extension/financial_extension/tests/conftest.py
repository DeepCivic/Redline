"""Shared fixtures: an in-memory async SQLite DB + a TestClient over the router.

The overlay is provable standalone (no Postgres, no GPU, no vendored fork) by
running the models + config API against aiosqlite. The migration itself is
exercised separately in ``test_migration.py`` against SQLite too.
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
from numbatch_financial.models import Base


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
