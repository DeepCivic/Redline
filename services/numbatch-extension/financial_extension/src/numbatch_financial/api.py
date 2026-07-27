"""The financial-profile config API — an additive FastAPI router for the fork.

Mounted onto the forked Numbatch backend's app (``app.include_router`` in the
fork; ``build_app`` here for standalone tests). Two routers:

    POST /financial-profiles              create one profile for a topic (idempotent)
    GET  /financial-profiles              list all profiles
    GET  /financial-profiles/{id}         read one profile
    GET  /financial-extractions/{doc_id}  read a document's extracted figures

The config endpoints (Thread 6) are idempotent by ``topic_id`` (a topic = a
redline requirement): re-creating for a topic that already has a live profile
returns the existing one (200), never a duplicate — matching the bootstrap's
"safe to re-run" contract (ADR-0005). The extraction read endpoint (Thread 8)
serves the figures the Thread 7 worker wrote so the ``NumbatchFinancialExtractor``
adapter can fill ``ProcurementResponse.costing``.

Errors are Result-shaped (``{"error": {"code", "message"}}``) to mirror the
womblex sidecar and map cleanly into the Thread 8 adapter's ``DomainError``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi import APIRouter, Depends, FastAPI, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .extraction_repository import FinancialExtractionRepository
from .repository import FinancialProfileRepository
from .schemas import (
    DocumentExtractionsRead,
    FinancialExtractionRead,
    FinancialProfileCreate,
    FinancialProfileRead,
)

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


def build_extractions_router(get_session: SessionFactory) -> APIRouter:
    router = APIRouter(prefix="/financial-extractions", tags=["financial-extractions"])

    async def session_dependency() -> AsyncIterator[AsyncSession]:
        async for session in get_session():
            yield session

    @router.get("/{source_doc_id}", response_model=DocumentExtractionsRead)
    async def read_document_extractions(
        source_doc_id: str,
        session: AsyncSession = Depends(session_dependency),
    ):
        repository = FinancialExtractionRepository(session)
        rows = await repository.list_for_doc(source_doc_id)
        # A document with no extractions is a valid empty result, not a 404 — the
        # adapter reads "no figures yet" as an empty costing set, not a failure.
        return DocumentExtractionsRead(
            source_doc_id=source_doc_id,
            extractions=[
                FinancialExtractionRead.model_validate(row) for row in rows
            ],
        )

    return router


def build_app(get_session: SessionFactory) -> FastAPI:
    """Standalone app mounting both routers — used by the overlay's tests.

    In the fork, the routers are included on Numbatch's own app instead; this
    stands them up in isolation so the overlay's exit tests need neither the
    GPU-bearing inference service nor the rest of the backend.
    """

    app = FastAPI(title="numbatch-financial (overlay)")
    app.include_router(build_router(get_session))
    app.include_router(build_extractions_router(get_session))
    return app
