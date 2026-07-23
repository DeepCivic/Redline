"""Pydantic v2 request/response schemas for the financial-profile config API.

Numbatch's backend is FastAPI + Pydantic v2, so these mirror its DTO style. The
config API (Thread 6) is *schema only* — create and read financial profiles; the
worker that writes extractions is Thread 7.
"""

from __future__ import annotations

from datetime import datetime

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
