"""The financial-profile config API — an additive FastAPI router for the fork.

Mounted onto the forked Numbatch backend's app (``app.include_router`` in the
fork; ``build_app`` here for standalone tests). Thread 6 is *schema + config API*:

    POST /financial-profiles           create one profile for a topic (idempotent)
    GET  /financial-profiles           list all profiles
    GET  /financial-profiles/{id}      read one profile

Idempotent by ``topic_id`` (a topic = a redline requirement): re-creating for a
topic that already has a live profile returns the existing one (200), never a
duplicate — matching the bootstrap's "safe to re-run" contract (ADR-0005).

Errors are Result-shaped (``{"error": {"code", "message"}}``) to mirror the
womblex sidecar and map cleanly into the Thread 8 adapter's ``DomainError``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi import APIRouter, Depends, FastAPI, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .repository import FinancialProfileRepository
from .schemas import FinancialProfileCreate, FinancialProfileRead

SessionFactory = Callable[[], AsyncIterator[AsyncSession]]


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"error": {"code": code, "message": message}}
    )


def build_router(get_session: SessionFactory) -> APIRouter:
    router = APIRouter(prefix="/financial-profiles", tags=["financial-profiles"])

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async for session in get_session():
            yield session

    @router.post("", response_model=FinancialProfileRead)
    async def create_financial_profile(
        payload: FinancialProfileCreate,
        response: Response,
        session: AsyncSession = Depends(session_dependency),
    ):
        repository = FinancialProfileRepository(session)

        existing = await repository.get_by_topic(payload.topic_id)
        if existing is not None:
            # Idempotent: one live profile per topic. Re-create is a no-op read.
            response.status_code = status.HTTP_200_OK
            return FinancialProfileRead.model_validate(existing)

        created = await repository.create(payload)
        await session.commit()
        response.status_code = status.HTTP_201_CREATED
        return FinancialProfileRead.model_validate(created)

    @router.get("", response_model=list[FinancialProfileRead])
    async def list_financial_profiles(
        session: AsyncSession = Depends(session_dependency),
    ):
        repository = FinancialProfileRepository(session)
        profiles = await repository.list_all()
        return [FinancialProfileRead.model_validate(profile) for profile in profiles]

    @router.get("/{profile_id}", response_model=FinancialProfileRead)
    async def read_financial_profile(
        profile_id: str,
        session: AsyncSession = Depends(session_dependency),
    ):
        repository = FinancialProfileRepository(session)
        profile = await repository.get_by_id(profile_id)
        if profile is None:
            return _error(
                status.HTTP_404_NOT_FOUND,
                "NOT_FOUND",
                f"no financial profile {profile_id}",
            )
        return FinancialProfileRead.model_validate(profile)

    return router


def build_app(get_session: SessionFactory) -> FastAPI:
    """Standalone app mounting only this router — used by the overlay's tests.

    In the fork, ``build_router`` is included on Numbatch's own app instead; this
    stands the router up in isolation so Thread 6's exit test needs neither the
    GPU-bearing inference service nor the rest of the backend.
    """

    app = FastAPI(title="numbatch-financial (overlay)")
    app.include_router(build_router(get_session))
    return app
