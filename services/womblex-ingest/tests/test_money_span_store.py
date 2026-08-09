"""The money-span load path: womblex's `*.money_spans.parquet` → `redline_money_spans`.

`DrizzleMoneySpanStore`'s header asserted this writer existed; nothing did. The
consequence was silent — `MoneySpanFinancialExtractor` reads an empty table,
`spans.data.length === 0` short-circuits, and every grid row lands with no costing
— so the financial half of the product could not run on any lane, stub or real.

These tests are the writer's spec, and they assert **field by field against the
shard**, never against a total: the point of the load is that womblex's span
arrives uninterpreted. All three loci, the qualifiers womblex refuses to fold into
`value` (`modifier`, `multiplier`, `negative`) and the range grouping must survive.

Only the shard is synthesised here — from a mirror of womblex's own
`MONEY_SPANS_SCHEMA`, pinned against the engine's real schema object by
`test_the_mirrored_money_spans_schema_matches_the_engines` wherever the
`[womblex]` extra is installed. The default validate box installs `[dev]` alone,
which carries pyarrow, so the mapping half runs everywhere.
"""

from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

from tests.conftest import FakeObjectStorage, RecordingMoneySpanStore  # noqa: E402
from womblex_ingest.money_span_store import (  # noqa: E402
    MONEY_SPANS_SCHEMA,
    MoneySpanShardError,
    load_money_spans,
)
from womblex_ingest.money_stage import MoneyStageResult, run_money_stage  # noqa: E402
from womblex_ingest.money_span_store_postgres import INSERT_COLUMNS  # noqa: E402

EVAL = "eval-money"
DOC = "82f9355eabcd0001"

# womblex's column → the store field it lands in. Written out here rather than
# imported from the writer, so the test is a second, independent statement of the
# mapping the exit criterion turns on.
COLUMN_TO_FIELD = {
    "source_hash": "document_id",
    "locus": "locus",
    "text_source": "text_source",
    "start_char": "start_char",
    "end_char": "end_char",
    "page": "page",
    "elem_order": "element_order",
    "parent_elem_order": "parent_element_order",
    "sheet": "sheet",
    "row": "row_index",
    "col": "column_index",
    "text": "text",
    "value": "value",
    "currency": "currency",
    "currency_source": "currency_source",
    "evidence": "evidence",
    "modifier": "modifier",
    "multiplier": "multiplier",
    "negative": "negative",
    "confidence": "confidence",
    "range_group": "range_group",
    "range_role": "range_role",
    "column_id": "column_id",
    "context": "context",
}


def _row(**over) -> dict:
    """A shard row with every column present, as womblex writes them."""
    row = {field.name: None for field in MONEY_SPANS_SCHEMA}
    row.update({"source_hash": DOC, "negative": False, "confidence": 0.9})
    row.update(over)
    return row


def _table_cell(**over) -> dict:
    return _row(**{
        "locus": "table_cell", "parent_elem_order": 4, "row": 1, "col": 2,
        "text": "1500.50", "value": Decimal("1500.5000"), "currency": "AUD",
        "currency_source": "column_header", "evidence": "header+numeric",
        "confidence": 0.92, "column_id": "elem4:col2", **over,
    })


def _narrative(**over) -> dict:
    return _row(**{
        "locus": "narrative", "text_source": "elements", "start_char": 120,
        "end_char": 134, "page": 3, "text": "$2.4 million",
        "value": Decimal("2400000.0000"), "currency": "AUD",
        "currency_source": "symbol", "evidence": "p3", "multiplier": "million",
        "context": "the total contract value is $2.4 million over four years", **over,
    })


def _sheet_cell(**over) -> dict:
    return _row(**{
        "locus": "sheet_cell", "elem_order": 88, "sheet": "Pricing", "row": 12,
        "col": 3, "text": "80000", "value": Decimal("80000.0000"), "currency": "AUD",
        "currency_source": "number_format", "evidence": "number_format",
        "column_id": "sheet:Pricing:col3", **over,
    })


def _write_shard(shard_dir: Path, rows: list[dict], name: str = "batch-0000") -> list[dict]:
    """Write a shard and hand back what it actually holds.

    The round-trip matters: `confidence` is `float32` on the wire, so the shard's
    0.9 is not Python's 0.9. The exit criterion is fidelity to the shard, so the
    shard — not the literal that produced it — is what the assertions compare with.
    """
    path = shard_dir / f"{name}.money_spans.parquet"
    pq.write_table(pa.Table.from_pylist(rows, schema=MONEY_SPANS_SCHEMA), path)
    return pq.read_table(path).to_pylist()


def _assert_matches_shard(shard_row: dict, stored) -> None:
    """Every womblex column, landed unchanged in the store's row."""
    for column, field in COLUMN_TO_FIELD.items():
        expected = shard_row[column]
        if column == "value":
            expected = format(expected, "f")
        assert getattr(stored, field) == expected, column


# --- The exit criterion ------------------------------------------------------


def test_lands_every_span_of_every_locus_field_by_field(tmp_path: Path) -> None:
    shard_rows = _write_shard(tmp_path, [_narrative(), _table_cell(), _sheet_cell()])
    store = RecordingMoneySpanStore()

    loaded = load_money_spans(store, EVAL, tmp_path)

    assert loaded == 3
    stored = store.spans[(EVAL, DOC)]
    assert [row.locus for row in stored] == ["narrative", "table_cell", "sheet_cell"]
    for shard_row, stored_row in zip(shard_rows, stored):
        _assert_matches_shard(shard_row, stored_row)


def test_keeps_a_qualifier_off_the_value(tmp_path: Path) -> None:
    # womblex never folds `modifier` into `value`; dropping the column made
    # "up to $2M" indistinguishable from an exact $2M.
    shard_row = _narrative(text="up to $2M", value=Decimal("2000000.0000"), modifier="up to")
    _write_shard(tmp_path, [shard_row])
    store = RecordingMoneySpanStore()

    load_money_spans(store, EVAL, tmp_path)

    stored = store.spans[(EVAL, DOC)][0]
    assert stored.value == "2000000.0000"
    assert stored.modifier == "up to"
    assert stored.multiplier == "million"


def test_keeps_both_endpoints_of_a_range_distinguishable(tmp_path: Path) -> None:
    _write_shard(tmp_path, [
        _narrative(value=Decimal("1000000.0000"), range_group=7, range_role="lower"),
        _narrative(start_char=136, end_char=142, value=Decimal("2000000.0000"),
                   range_group=7, range_role="upper"),
    ])
    store = RecordingMoneySpanStore()

    load_money_spans(store, EVAL, tmp_path)

    stored = store.spans[(EVAL, DOC)]
    assert [(row.range_group, row.range_role) for row in stored] == [(7, "lower"), (7, "upper")]


def test_keeps_the_sign_and_the_exact_scale(tmp_path: Path) -> None:
    # decimal128(38,4) exists because summing amounts as floats accumulates error
    # and reconciliation compares for equality; the string must keep all four places.
    _write_shard(tmp_path, [_table_cell(text="(1,200.00)", value=Decimal("-1200.0000"),
                                        negative=True)])
    store = RecordingMoneySpanStore()

    load_money_spans(store, EVAL, tmp_path)

    stored = store.spans[(EVAL, DOC)][0]
    assert stored.value == "-1200.0000"
    assert stored.negative is True


# --- Identity ----------------------------------------------------------------


def test_two_amounts_in_one_cell_land_as_two_addressable_rows(tmp_path: Path) -> None:
    # womblex scans every cell of an unclassified column for self-evidencing
    # amounts, so (document, parent_elem_order, row, col) identifies no row on its
    # own — "Base $100 plus GST $10" is one cell and two spans.
    _write_shard(tmp_path, [
        _table_cell(text="$100", value=Decimal("100.0000"), column_id=None),
        _table_cell(text="$10", value=Decimal("10.0000"), column_id=None),
    ])
    store = RecordingMoneySpanStore()

    loaded = load_money_spans(store, EVAL, tmp_path)

    stored = store.spans[(EVAL, DOC)]
    assert loaded == 2
    assert len({row.span_id for row in stored}) == 2
    assert [row.value for row in stored] == ["100.0000", "10.0000"]


def test_a_second_load_replaces_a_documents_spans_rather_than_duplicating(tmp_path: Path) -> None:
    _write_shard(tmp_path, [_table_cell()])
    store = RecordingMoneySpanStore()

    load_money_spans(store, EVAL, tmp_path)
    load_money_spans(store, EVAL, tmp_path)

    assert len(store.spans[(EVAL, DOC)]) == 1
    assert store.replace_calls == 2


def test_span_ids_are_stable_across_loads(tmp_path: Path) -> None:
    _write_shard(tmp_path, [_narrative(), _table_cell(), _table_cell()])
    first = RecordingMoneySpanStore()
    second = RecordingMoneySpanStore()

    load_money_spans(first, EVAL, tmp_path)
    load_money_spans(second, EVAL, tmp_path)

    assert [row.span_id for row in first.spans[(EVAL, DOC)]] == [
        row.span_id for row in second.spans[(EVAL, DOC)]
    ]


# --- Shard handling ----------------------------------------------------------


def test_groups_a_batchs_rows_by_document(tmp_path: Path) -> None:
    other = "aaaa000011112222"
    _write_shard(tmp_path, [_table_cell(), _table_cell(source_hash=other), _narrative()])
    store = RecordingMoneySpanStore()

    load_money_spans(store, EVAL, tmp_path)

    assert len(store.spans[(EVAL, DOC)]) == 2
    assert len(store.spans[(EVAL, other)]) == 1


def test_reads_every_batch_shard_under_the_directory(tmp_path: Path) -> None:
    _write_shard(tmp_path, [_table_cell()], name="batch-0000")
    _write_shard(tmp_path, [_narrative()], name="batch-0001")
    store = RecordingMoneySpanStore()

    loaded = load_money_spans(store, EVAL, tmp_path)

    assert loaded == 2
    assert len(store.spans[(EVAL, DOC)]) == 2


def test_no_money_shard_loads_nothing_without_failing(tmp_path: Path) -> None:
    # The money stage is an optional overlay: an evaluation it has not run over
    # has no sidecars, and that is an absent resource, not a broken load.
    store = RecordingMoneySpanStore()

    assert load_money_spans(store, EVAL, tmp_path) == 0
    assert store.spans == {}


def test_a_shard_missing_a_column_fails_loudly(tmp_path: Path) -> None:
    # A schema bump that drops a column must not land half a span quietly — that
    # failure mode is exactly what left this table empty in the first place.
    narrowed = pa.schema([field for field in MONEY_SPANS_SCHEMA if field.name != "modifier"])
    row = {name: value for name, value in _table_cell().items() if name != "modifier"}
    pq.write_table(
        pa.Table.from_pylist([row], schema=narrowed),
        tmp_path / "batch-0000.money_spans.parquet",
    )

    with pytest.raises(MoneySpanShardError):
        load_money_spans(RecordingMoneySpanStore(), EVAL, tmp_path)


# --- Wiring: the stage publishes, then loads ---------------------------------


def test_the_money_stage_loads_the_sidecar_it_just_published() -> None:
    """The stage's fourth step, proven on the lane the default validate box runs.

    `test_money_stage.py` drives the same path against womblex's real annotation
    wherever the `[womblex]` extra is installed; here the annotation is faked so
    only the plumbing is under test — publish the sidecar, then read it back into
    the store. That plumbing is exactly what was missing, and nothing failed
    loudly for its absence.
    """
    prefix = f"proc/{EVAL}/documents/"
    storage = FakeObjectStorage()
    storage.put_object(f"{prefix}batch-0000.elements.parquet", b"elements", "application/octet-stream")
    store = RecordingMoneySpanStore()

    def annotate(shard_dir: Path) -> MoneyStageResult:
        _write_shard(shard_dir, [_table_cell(), _narrative()])
        return MoneyStageResult(
            batches_written=1, spans_written=2, columns_classified=1, money_columns=1
        )

    run_money_stage(storage, evaluation_id=EVAL, money_shards=annotate, span_store=store)

    assert f"{prefix}batch-0000.money_spans.parquet" in storage.keys_under(prefix)
    assert [row.locus for row in store.spans[(EVAL, DOC)]] == ["table_cell", "narrative"]


# --- The two contracts this writer sits between ------------------------------


def test_the_mirrored_money_spans_schema_matches_the_engines() -> None:
    """redline's assumed money-span schema is womblex's actual one.

    Runs only where the `.[womblex]` extra is installed, but where it runs, a
    submodule bump that changes the shard schema fails here rather than three
    layers downstream as an empty financial column. `validate.sh` #13 pins the
    submodule tag to the sidecar's declared version, closing the loop.
    """
    money_output = pytest.importorskip("womblex.store.money_output")

    assert MONEY_SPANS_SCHEMA.equals(money_output.MONEY_SPANS_SCHEMA)


def test_the_writer_only_names_columns_the_redline_migration_creates() -> None:
    """The writer's INSERT and `redline_money_spans` agree, column for column.

    The two halves are in different languages and different packages, and the last
    time they disagreed the table simply stayed empty. This is the guard: the
    migration SQL is redline's own, so a widened writer that outruns it fails here.
    """
    migrations = Path(__file__).parents[3] / "packages/redline-adapters/src/persistence/migrations"
    if not migrations.is_dir():
        pytest.skip("redline-adapters migrations not present in this checkout")

    declared: set[str] = set()
    for sql_file in sorted(migrations.glob("*.sql")):
        sql = sql_file.read_text()
        declared.update(re.findall(
            r'ALTER TABLE "redline_money_spans" ADD COLUMN IF NOT EXISTS "([a-z_]+)"', sql))
        declared.update(re.findall(
            r'ALTER TABLE "redline_money_spans" RENAME COLUMN "[a-z_]+" TO "([a-z_]+)"', sql))
        table = re.search(
            r'CREATE TABLE IF NOT EXISTS "redline_money_spans" \((.*?)\n\);', sql, re.S)
        if table:
            declared.update(re.findall(r'^\s*"([a-z_]+)"', table.group(1), re.M))

    assert declared, "no redline_money_spans columns found in the migrations"
    assert set(INSERT_COLUMNS) <= declared, set(INSERT_COLUMNS) - declared
