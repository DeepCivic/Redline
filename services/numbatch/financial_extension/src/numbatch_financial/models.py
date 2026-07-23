"""SQLAlchemy models for redline's financial extension to the Numbatch backend.

Two additive tables (ADR-0005 — the financial extension is additive: new tables +
a new Arq worker stage), designed to drop into the forked Numbatch backend's
``app/models`` alongside its existing declarative models:

- ``financial_profiles`` — per Numbatch topic (= a redline requirement/criterion,
  ADR-0004), a config declaring *what* monetary facts to pull and *how* to
  normalise them. This is the Thread 6 config surface.
- ``financial_extractions`` — the financial worker's output (Thread 7): one extracted
  figure (or description fallback) per ``(source_doc_id, topic_id)`` pair, with
  provenance back to womblex's ``elem_order``. Declared in Thread 6 so the
  migration creates both tables in one additive step; written by
  ``worker.py``/``extraction_repository.py`` (Thread 7).

Keyed on ``(source_doc_id, topic_id)`` so a figure attaches to a (document,
requirement) pair via the batch-inference roll-up's matched-chunk provenance —
Numbatch already guarantees a chunk feeds a topic at most once, so there is no
re-extraction per requirement and no duplication (build plan §6).

In the fork these bind to Numbatch's own ``Base``/``metadata``; here we declare a
local ``Base`` so the overlay is testable standalone (SQLite) without vendoring
the GPU-bearing fork on disk. ``TABLE_ARGS_SCHEMA`` is left ``None`` to match the
fork's public search-path convention.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Local declarative base.

    Mirrors the fork's convention so these models graft onto Numbatch's own
    ``Base`` unchanged when vendored (Thread 16): a uuid string ``id`` and
    server-defaulted ``created_at`` / ``updated_at`` on every table.
    """


def _new_uuid() -> str:
    return str(uuid.uuid4())


class CostBasis(str, enum.Enum):
    """How a monetary fact recurs — one-off vs recurring (build plan §6)."""

    ONE_OFF = "one_off"
    RECURRING = "recurring"


class LineItemGranularity(str, enum.Enum):
    """Whether to pull per-line-item figures or a single bundle total."""

    LINE_ITEM = "line_item"
    BUNDLE = "bundle"


class FinancialProfile(Base):
    """Per-topic config: what monetary facts to pull and how to normalise them.

    One live profile per ``topic_id`` (a topic = a redline requirement). The
    config declares the target currency to normalise into, whether costs are
    one-off or recurring, and whether to extract line items or a bundle total.
    """

    __tablename__ = "financial_profiles"
    __table_args__ = (
        UniqueConstraint("topic_id", name="uq_financial_profiles_topic"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    # The Numbatch topic this profile configures. FK to topics in the fork; a
    # plain indexed column here so the overlay tests standalone.
    topic_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # ISO-4217 code the worker normalises figures into (e.g. "AUD").
    target_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    cost_basis: Mapped[CostBasis] = mapped_column(
        Enum(CostBasis, name="financial_cost_basis"),
        nullable=False,
        default=CostBasis.ONE_OFF,
    )
    granularity: Mapped[LineItemGranularity] = mapped_column(
        Enum(LineItemGranularity, name="financial_line_item_granularity"),
        nullable=False,
        default=LineItemGranularity.BUNDLE,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    extractions: Mapped[list["FinancialExtraction"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )


class FinancialExtraction(Base):
    """One extracted figure (or description fallback) per (document, topic).

    Written by the Thread 7 Arq worker (``worker.py`` → ``extraction_repository``);
    declared in Thread 6 so its migration creates both tables. Keyed uniquely on
    ``(source_doc_id, topic_id)`` — the no-duplication invariant (build plan §6):
    exactly one figure per (document, requirement).
    """

    __tablename__ = "financial_extractions"
    __table_args__ = (
        UniqueConstraint(
            "source_doc_id",
            "topic_id",
            name="uq_financial_extractions_doc_topic",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_new_uuid)
    # Womblex's source_hash — the document identity the roll-up is keyed on.
    source_doc_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    topic_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    financial_profile_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("financial_profiles.id"), nullable=False
    )
    # The normalised figure, or NULL when only a description was available.
    amount: Mapped[float | None] = mapped_column(Numeric(18, 2), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    # Short prose used when no figure was provided ("dollar estimate OR a short
    # description of costs" — build plan §1). Always populated.
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Provenance back to womblex's elem_order for the matched chunk.
    source_elem_order: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    profile: Mapped[FinancialProfile] = relationship(back_populates="extractions")
