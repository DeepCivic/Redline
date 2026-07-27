"""redline financial extension: financial_profiles + financial_extractions.

Revision ID: redline_financial_0001
Revises: <numbatch head>
Create Date: 2026-07-27

Additive migration (ADR-0005): two new tables grafted onto the forked Numbatch
schema. ``down_revision`` is left ``None`` in the overlay so the migration is
runnable/testable standalone; when vendored into the fork it is repointed at
Numbatch's current head so ``alembic upgrade head`` applies it after the base
schema (see README — "Wiring into the fork").
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "redline_financial_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    cost_basis = sa.Enum("one_off", "recurring", name="financial_cost_basis")
    granularity = sa.Enum(
        "line_item", "bundle", name="financial_line_item_granularity"
    )

    op.create_table(
        "financial_profiles",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("topic_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("target_currency", sa.String(length=3), nullable=False),
        sa.Column("cost_basis", cost_basis, nullable=False, server_default="one_off"),
        sa.Column(
            "granularity", granularity, nullable=False, server_default="bundle"
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("topic_id", name="uq_financial_profiles_topic"),
    )
    op.create_index(
        "ix_financial_profiles_topic_id", "financial_profiles", ["topic_id"]
    )

    op.create_table(
        "financial_extractions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("source_doc_id", sa.String(length=128), nullable=False),
        sa.Column("topic_id", sa.String(length=36), nullable=False),
        sa.Column(
            "financial_profile_id",
            sa.String(length=36),
            sa.ForeignKey("financial_profiles.id"),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("currency", sa.String(length=3), nullable=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_elem_order", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "source_doc_id",
            "topic_id",
            name="uq_financial_extractions_doc_topic",
        ),
    )
    op.create_index(
        "ix_financial_extractions_source_doc_id",
        "financial_extractions",
        ["source_doc_id"],
    )
    op.create_index(
        "ix_financial_extractions_topic_id", "financial_extractions", ["topic_id"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_financial_extractions_topic_id", table_name="financial_extractions"
    )
    op.drop_index(
        "ix_financial_extractions_source_doc_id", table_name="financial_extractions"
    )
    op.drop_table("financial_extractions")
    op.drop_index("ix_financial_profiles_topic_id", table_name="financial_profiles")
    op.drop_table("financial_profiles")
    sa.Enum(name="financial_line_item_granularity").drop(op.get_bind())
    sa.Enum(name="financial_cost_basis").drop(op.get_bind())
