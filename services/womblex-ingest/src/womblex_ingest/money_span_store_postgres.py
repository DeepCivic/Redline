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

# Each column paired with the `MoneySpanRow` attribute it carries. ONE list, not a
# column tuple beside a value tuple: most of these columns are text, so a pair
# transposed between two parallel lists would write `evidence` into `modifier` and
# nothing would raise. `created_at` / `updated_at` are left to the table's defaults.
ROW_COLUMNS = (
    ("id", "span_id"),
    ("document_id", "document_id"),
    ("locus", "locus"),
    ("text_source", "text_source"),
    ("start_char", "start_char"),
    ("end_char", "end_char"),
    ("page", "page"),
    ("element_order", "element_order"),
    ("parent_element_order", "parent_element_order"),
    ("sheet", "sheet"),
    ("row_index", "row_index"),
    ("column_index", "column_index"),
    ("text", "text"),
    ("value", "value"),
    ("currency", "currency"),
    ("currency_source", "currency_source"),
    ("evidence", "evidence"),
    ("modifier", "modifier"),
    ("multiplier", "multiplier"),
    ("negative", "negative"),
    ("confidence", "confidence"),
    ("range_group", "range_group"),
    ("range_role", "range_role"),
    ("column_id", "column_id"),
    ("context", "context"),
)

# `evaluation_id` is the caller's scope, not the span's, so it is the one column
# with no attribute behind it.
INSERT_COLUMNS = ("evaluation_id", *(column for column, _ in ROW_COLUMNS))

_INSERT_SQL = (
    f"INSERT INTO redline_money_spans ({', '.join(INSERT_COLUMNS)}) "
    f"VALUES ({', '.join(['%s'] * len(INSERT_COLUMNS))})"
)

_DELETE_SQL = "DELETE FROM redline_money_spans WHERE evaluation_id = %s"


def _insert_values(evaluation_id: str, row: MoneySpanRow) -> tuple:
    return (evaluation_id, *(getattr(row, attribute) for _, attribute in ROW_COLUMNS))


class PostgresMoneySpanStore:
    """`MoneySpanStore` over `redline_money_spans`."""

    def __init__(self, dsn: str) -> None:
        import psycopg

        self._connect = lambda: psycopg.connect(dsn)

    def replace_evaluation_spans(
        self, evaluation_id: str, rows: Sequence[MoneySpanRow]
    ) -> None:
        # Delete + insert in one transaction: a re-annotated evaluation must never
        # be readable as its old spans and its new ones at once.
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(_DELETE_SQL, (evaluation_id,))
                cursor.executemany(
                    _INSERT_SQL, [_insert_values(evaluation_id, row) for row in rows]
                )
            connection.commit()


__all__ = ["INSERT_COLUMNS", "ROW_COLUMNS", "PostgresMoneySpanStore"]
