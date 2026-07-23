"""Migration test — the Thread 6 exit test's second half: the migration applies.

Runs the Alembic revision's ``upgrade()`` against an in-memory SQLite DB through
a real Alembic ``MigrationContext``/``Operations`` (not the ORM's
``create_all``), so the hand-written migration is exercised as CI would apply it:
tables created, the ``(source_doc_id, topic_id)`` uniqueness enforced, and
``downgrade()`` reverses cleanly. Enum types are Postgres-native in production;
SQLite renders them as VARCHAR, which is fine for structural verification.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "redline_financial_0001_financial_tables.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("redline_financial_0001", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_upgrade_creates_both_tables() -> None:
    migration = _load_migration()
    engine = sa.create_engine("sqlite:///:memory:")

    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

        tables = set(sa.inspect(connection).get_table_names())
        assert {"financial_profiles", "financial_extractions"} <= tables


def test_extractions_are_unique_per_doc_and_topic() -> None:
    migration = _load_migration()
    engine = sa.create_engine("sqlite:///:memory:")

    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

        connection.execute(
            sa.text(
                "INSERT INTO financial_profiles "
                "(id, topic_id, name, target_currency, cost_basis, granularity) "
                "VALUES ('p1', 't1', 'n', 'AUD', 'one_off', 'bundle')"
            )
        )

        def insert_extraction(row_id: str) -> None:
            connection.execute(
                sa.text(
                    "INSERT INTO financial_extractions "
                    "(id, source_doc_id, topic_id, financial_profile_id, description) "
                    f"VALUES ('{row_id}', 'doc-1', 't1', 'p1', '')"
                )
            )

        insert_extraction("e1")
        try:
            insert_extraction("e2")
            raise AssertionError("expected a uniqueness violation on (source_doc_id, topic_id)")
        except sa.exc.IntegrityError:
            pass


def test_downgrade_removes_both_tables() -> None:
    migration = _load_migration()
    engine = sa.create_engine("sqlite:///:memory:")

    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()
            migration.downgrade()

        tables = set(sa.inspect(connection).get_table_names())
        assert "financial_profiles" not in tables
        assert "financial_extractions" not in tables
