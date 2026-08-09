"""The psycopg-backed `MoneySpanStore` over `redline_money_spans`.

The real implementation of `money_span_store.MoneySpanStore`, writing womblex's
money spans into redline's own Postgres (ADR-0002) for `DrizzleMoneySpanStore` and
the report tools to read back.

Unlike `PostgresChunkStore`, this store carries **no DDL and no `migrate()`**. The
table is `redline_money_spans`, created by redline-adapters' own migrations, and it
holds a foreign key to `redline_evaluations` — a table this sidecar has no business
creating. Two hand-authored DDLs for one table is the drift that leaves a writer
and its table disagreeing, so there is exactly one:
`packages/redline-adapters/src/persistence/migrations/`.
`test_the_writer_only_names_columns_the_redline_migration_creates` holds the two to
each other.

psycopg is imported lazily (as `storage.py` does with boto3) so this module imports
for the column-contract test without the driver installed.
"""

from __future__ import annotations

from typing import Sequence

from womblex_ingest.money_span_store import MoneySpanRow

# The columns the writer names, in insert order. `created_at` / `updated_at` are
# left to the table's defaults.
INSERT_COLUMNS = (
    "id",
    "evaluation_id",
    "document_id",
    "locus",
    "text_source",
    "start_char",
    "end_char",
    "page",
    "element_order",
    "parent_element_order",
    "sheet",
    "row_index",
    "column_index",
    "text",
    "value",
    "currency",
    "currency_source",
    "evidence",
    "modifier",
    "multiplier",
    "negative",
    "confidence",
    "range_group",
    "range_role",
    "column_id",
    "context",
)

_INSERT_SQL = (
    f"INSERT INTO redline_money_spans ({', '.join(INSERT_COLUMNS)}) "
    f"VALUES ({', '.join(['%s'] * len(INSERT_COLUMNS))})"
)

_DELETE_SQL = "DELETE FROM redline_money_spans WHERE evaluation_id = %s AND document_id = %s"


def _insert_values(evaluation_id: str, row: MoneySpanRow) -> tuple:
    return (
        row.span_id,
        evaluation_id,
        row.document_id,
        row.locus,
        row.text_source,
        row.start_char,
        row.end_char,
        row.page,
        row.element_order,
        row.parent_element_order,
        row.sheet,
        row.row_index,
        row.column_index,
        row.text,
        row.value,
        row.currency,
        row.currency_source,
        row.evidence,
        row.modifier,
        row.multiplier,
        row.negative,
        row.confidence,
        row.range_group,
        row.range_role,
        row.column_id,
        row.context,
    )


class PostgresMoneySpanStore:
    """`MoneySpanStore` over `redline_money_spans`."""

    def __init__(self, dsn: str) -> None:
        import psycopg

        self._connect = lambda: psycopg.connect(dsn)

    def replace_document_spans(
        self, evaluation_id: str, document_id: str, rows: Sequence[MoneySpanRow]
    ) -> None:
        # Delete + insert in one transaction: a re-annotated document must never be
        # readable as its old spans and its new ones at once, and no span id is
        # stable enough across a re-run to upsert on.
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(_DELETE_SQL, (evaluation_id, document_id))
                cursor.executemany(
                    _INSERT_SQL, [_insert_values(evaluation_id, row) for row in rows]
                )
            connection.commit()


__all__ = ["INSERT_COLUMNS", "PostgresMoneySpanStore"]
