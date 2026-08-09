"""Item 1 — the `money` stage invocation over object storage, end to end.

`womblex money --shards` only accepts a local directory, but the distributed
lane's shards live in object storage under `proc/{evaluationId}/.../documents/`
(the same layout `RealWomblexExtractor` reads). `run_money_stage` is the
stage-in / run / stage-out step that closes that gap: it downloads the batch's
`*.elements.parquet` + `*.table_cells.parquet` to a scratch dir, calls womblex's
own `money_shards()` over it, and pushes the two `*.money_spans.parquet` /
`*.money_columns.parquet` siblings back beside the shards they annotate.

These tests drive the **real** stage — womblex's own `money_shards` via
`_load_money_shards()` — over **real** Parquet shards built from the `tender.csv`
fixture using womblex's own schemas. Only the object-storage seam is faked (the
in-memory `FakeObjectStorage`, the same posture `test_real_extractor.py` takes);
the download -> `money_shards` -> publish path is the production one. The suite is
gated on the `[womblex]` extra (`importorskip`), like the real-extractor lane, so
the default validate box — which installs `[dev]` alone — skips it rather than
reporting green over an unrun stage.
"""

from __future__ import annotations

import csv
import io
from decimal import Decimal
from pathlib import Path

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")
pytest.importorskip("womblex")

from tests.conftest import FakeObjectStorage, RecordingMoneySpanStore  # noqa: E402
from womblex.store.output import (  # noqa: E402
    ELEMENT_SCHEMA,
    MANIFEST_SCHEMA,
    TABLE_CELLS_SCHEMA,
)
from womblex_ingest.money_stage import (  # noqa: E402
    ShardPrefixEmpty,
    main,
    run_money_stage,
)

EVAL = "eval-money"
PREFIX = f"proc/{EVAL}/documents/"
DOC = "tender-doc"
CORPUS = Path(__file__).parent / "corpus" / "tender.csv"


# --- Real shard construction from the fixture --------------------------------
#
# The engine writes `*.elements`/`*.table_cells` for a document; we build the same
# shards from `tender.csv` so `money_shards` reads real Parquet. The tender's
# priced rows become one table whose `amount` column carries the header
# `Amount (AUD)` — the column-evidenced money shape redline exists to recover.


def _element_row(order: int, kind: str, **kwargs) -> dict:
    row = {field.name: None for field in ELEMENT_SCHEMA}
    row.update({
        "source_hash": DOC, "collection_id": "c", "elem_order": order,
        "kind": kind, "extractor": "test", "confidence": 1.0, "page": 1,
    })
    row.update(kwargs)
    return row


def _cell_row(row_index: int, col: int, value: str) -> dict:
    row = {field.name: None for field in TABLE_CELLS_SCHEMA}
    row.update({
        "source_hash": DOC, "parent_elem_order": 0, "row": row_index, "col": col,
        "value": value, "rowspan": 1, "colspan": 1, "value_type": "text",
    })
    return row


def _fixture_amounts() -> list[str]:
    with CORPUS.open(newline="") as handle:
        return [row["amount"] for row in csv.DictReader(handle)]


def _priced_amounts() -> list[str]:
    return [amount for amount in _fixture_amounts() if amount]


def _parquet(rows: list[dict], schema: "pa.Schema") -> bytes:
    buffer = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), buffer)
    return buffer.getvalue()


def _put(storage: FakeObjectStorage, name: str, body: bytes) -> None:
    storage.put_object(f"{PREFIX}{name}", body, "application/octet-stream")


def _seed_real_shards(storage: FakeObjectStorage) -> None:
    """Land one batch of real `*.elements`/`*.table_cells`/`*._manifest` Parquet.

    One table: header row `Amount (AUD)`, then the tender's amount cells. A header
    declaring its own currency is exactly the money-column shape whose verdict
    supplies the currency the cells inherit.
    """
    elements = [_element_row(0, "table", header_rows=[0])]
    cells = [_cell_row(0, 0, "Amount (AUD)")]
    for index, amount in enumerate(_fixture_amounts(), start=1):
        cells.append(_cell_row(index, 0, amount))

    manifest = {field.name: None for field in MANIFEST_SCHEMA}
    manifest.update({"source_hash": DOC, "doc_id": DOC, "filename": "tender.csv", "status": "ok"})

    _put(storage, "batch-0000._manifest.parquet", _parquet([manifest], MANIFEST_SCHEMA))
    _put(storage, "batch-0000.elements.parquet", _parquet(elements, ELEMENT_SCHEMA))
    _put(storage, "batch-0000.table_cells.parquet", _parquet(cells, TABLE_CELLS_SCHEMA))
    # A sibling the money stage must not stage in.
    _put(storage, "batch-0000.embeddings.parquet", b"vectors")


def _spans_from(storage: FakeObjectStorage) -> list[dict]:
    body = storage.get_object(f"{PREFIX}batch-0000.money_spans.parquet")
    return pq.read_table(io.BytesIO(body)).to_pylist()


# --- End-to-end over the real stage ------------------------------------------


def test_publishes_both_sidecars_beside_the_shards() -> None:
    storage = FakeObjectStorage()
    _seed_real_shards(storage)

    run_money_stage(storage, evaluation_id=EVAL)

    published = set(storage.keys_under(PREFIX))
    assert f"{PREFIX}batch-0000.money_spans.parquet" in published
    assert f"{PREFIX}batch-0000.money_columns.parquet" in published


def test_recovers_the_currency_typed_amounts_from_the_column() -> None:
    storage = FakeObjectStorage()
    _seed_real_shards(storage)

    run_money_stage(storage, evaluation_id=EVAL)

    spans = _spans_from(storage)
    values = sorted(row["value"] for row in spans)
    # Every non-blank amount in the fixture, recovered as an exact Decimal in the
    # column the `Amount (AUD)` header classifies as money.
    expected = sorted(
        Decimal(amount).quantize(Decimal("0.0001")) for amount in _priced_amounts()
    )
    assert values == expected
    assert all(row["locus"] == "table_cell" for row in spans)
    assert {row["currency"] for row in spans} == {"AUD"}


def test_reports_the_stage_result_for_the_caller_to_log() -> None:
    storage = FakeObjectStorage()
    _seed_real_shards(storage)

    result = run_money_stage(storage, evaluation_id=EVAL)

    assert result.batches_written == 1
    assert result.spans_written == len(_priced_amounts())
    assert result.money_columns == 1


def test_no_elements_shard_under_the_prefix_fails_loudly() -> None:
    # An empty run would masquerade as "annotated, found no money"; the stage
    # refuses so a missing engine run is diagnosable — the same posture the
    # extraction binding takes for a missing shard prefix.
    storage = FakeObjectStorage()
    _put(storage, "batch-0000.embeddings.parquet", b"vectors")

    with pytest.raises(ShardPrefixEmpty):
        run_money_stage(storage, evaluation_id=EVAL)


def test_loads_the_published_spans_into_the_store_field_by_field() -> None:
    """The whole point of annotating: the spans reach `redline_money_spans`.

    Publishing a sidecar nothing reads is what left the financial half of the
    product unable to run on any lane. Asserted against the shard the real engine
    just wrote, column by column — not against a total, which would pass on a
    writer that dropped every qualifier.
    """
    storage = FakeObjectStorage()
    _seed_real_shards(storage)
    store = RecordingMoneySpanStore()

    run_money_stage(storage, evaluation_id=EVAL, span_store=store)

    published = _spans_from(storage)
    landed = store.spans[(EVAL, DOC)]
    assert len(landed) == len(published) == len(_priced_amounts())
    for shard_row, stored in zip(published, landed):
        assert stored.document_id == shard_row["source_hash"]
        assert stored.locus == shard_row["locus"]
        assert stored.text == shard_row["text"]
        assert stored.value == format(shard_row["value"], "f")
        assert stored.currency == shard_row["currency"]
        assert stored.currency_source == shard_row["currency_source"]
        assert stored.evidence == shard_row["evidence"]
        assert stored.confidence == shard_row["confidence"]
        assert stored.negative == shard_row["negative"]
        assert stored.parent_element_order == shard_row["parent_elem_order"]
        assert stored.row_index == shard_row["row"]
        assert stored.column_index == shard_row["col"]
        assert stored.column_id == shard_row["column_id"]
        assert stored.modifier == shard_row["modifier"]
        assert stored.multiplier == shard_row["multiplier"]
        assert stored.range_group == shard_row["range_group"]
        assert stored.range_role == shard_row["range_role"]


def test_publishes_the_sidecars_with_no_store_wired() -> None:
    # The air-gapped / no-DSN lane: the annotation still runs and the sidecars are
    # still durable in object storage, so the load can be replayed later.
    storage = FakeObjectStorage()
    _seed_real_shards(storage)

    run_money_stage(storage, evaluation_id=EVAL, span_store=None)

    assert f"{PREFIX}batch-0000.money_spans.parquet" in storage.keys_under(PREFIX)


# --- CLI entrypoint (the runnable step, mirrors `womblex finalize`) ----------


def test_cli_runs_the_real_stage_for_the_given_evaluation() -> None:
    storage = FakeObjectStorage()
    _seed_real_shards(storage)
    store = RecordingMoneySpanStore()

    exit_code = main(
        ["--evaluation-id", EVAL],
        build_storage=lambda: storage,
        build_span_store=lambda: store,
    )

    assert exit_code == 0
    assert f"{PREFIX}batch-0000.money_spans.parquet" in storage.keys_under(PREFIX)
    assert len(store.spans[(EVAL, DOC)]) == len(_priced_amounts())


def test_cli_requires_an_evaluation_id() -> None:
    with pytest.raises(SystemExit):
        main([], build_storage=FakeObjectStorage)


def test_cli_reports_a_missing_run_as_a_nonzero_exit() -> None:
    storage = FakeObjectStorage()

    exit_code = main(["--evaluation-id", EVAL], build_storage=lambda: storage)

    assert exit_code == 1
