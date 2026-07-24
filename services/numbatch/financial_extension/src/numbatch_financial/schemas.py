"""Pydantic v2 request/response schemas for the financial extension's API.

Numbatch's backend is FastAPI + Pydantic v2, so these mirror its DTO style. The
config API (Thread 6) creates and reads financial profiles; the extraction read
API (Thread 8) serves the figures the Thread 7 worker wrote, so the
``NumbatchFinancialExtractor`` adapter can fill ``ProcurementResponse.costing``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from .models import CostBasis, LineItemGranularity


class FinancialProfileCreate(BaseModel):
    """Body for ``POST /financial-profiles`` — configure one topic."""

    topic_id: str = Field(min_length=1, max_length=36)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    # ISO-4217; validated as three upper-case letters.
    target_currency: str = Field(pattern=r"^[A-Z]{3}$")
    cost_basis: CostBasis = CostBasis.ONE_OFF
    granularity: LineItemGranularity = LineItemGranularity.BUNDLE


class FinancialProfileRead(BaseModel):
    """Response for the profile config endpoints."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    topic_id: str
    name: str
    description: str
    target_currency: str
    cost_basis: CostBasis
    granularity: LineItemGranularity
    created_at: datetime
    updated_at: datetime


class FinancialExtractionRead(BaseModel):
    """One extracted figure (or description fallback) for a (document, topic).

    ``amount``/``currency`` are ``None`` when only a prose description of costs
    was available ("dollar estimate OR a short description" — build plan §1).
    ``topic_id`` is what the Thread 8 adapter maps back to a redline
    ``requirementId``; ``source_elem_order`` is womblex provenance.
    """

    model_config = ConfigDict(from_attributes=True)

    topic_id: str
    amount: Decimal | None
    currency: str | None
    description: str
    source_elem_order: int | None


class DocumentExtractionsRead(BaseModel):
    """All financial extractions for one document, keyed by its womblex source_hash."""

    source_doc_id: str
    extractions: list[FinancialExtractionRead]
