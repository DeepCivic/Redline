"""Thread 37b — the womblex-schema → JSON mapping, proven on plain row dicts.

These tests exercise `shard_reader.py` — the one place that understands womblex's
real Parquet schema — with hand-built row dicts, so the schema *contract* is
provable without pyarrow, a real shard, or the womblex engine (which only runs in
its own Python-3.12 pod, Thread 37a). The Parquet-decode + storage-read side of
the binding is covered by `test_real_extractor.py` (pyarrow-gated).
"""

from __future__ import annotations

import math

import pytest

from womblex_ingest.records import DocumentEmbeddings
from womblex_ingest.shard_reader import (
    ShardRows,
    ShardSchemaError,
    group_rows_by_document,
    map_chunk,
    map_document_embeddings,
    map_document_extraction,
    map_element,
    map_table_cell,
)

SOURCE_HASH = "82f9355eabcd0001"


def test_element_maps_source_hash_and_elem_order() -> None:
    element = map_element(SOURCE_HASH, {"elem_order": 3, "page": 2, "text": "Heading"})

    assert element.documentId == SOURCE_HASH
    assert element.elementOrder == 3
    assert element.page == 2
    assert element.text == "Heading"


def test_element_accepts_the_element_order_alias() -> None:
    element = map_element(SOURCE_HASH, {"element_order": 5, "text": "x"})

    assert element.elementOrder == 5
    # An absent page is a legitimate nullable, not a failure.
    assert element.page is None


def test_element_without_elem_order_is_a_schema_error() -> None:
    with pytest.raises(ShardSchemaError):
        map_element(SOURCE_HASH, {"page": 1, "text": "x"})


def test_chunk_id_is_recomposed_from_source_hash_and_chunk_index() -> None:
    # The seam's join key is {source_hash}:{chunk_index}, recomposed here rather
    # than trusting a producer's native chunk_id to agree with the embeddings'.
    chunk = map_chunk(SOURCE_HASH, {"chunk_index": 4, "chunk_id": "IGNORED", "text": "body"})

    assert chunk.chunkId == f"{SOURCE_HASH}:4"
    assert chunk.documentId == SOURCE_HASH
    assert chunk.text == "body"


def test_chunk_accepts_the_chunk_text_alias() -> None:
    chunk = map_chunk(SOURCE_HASH, {"chunk_index": 0, "chunk_text": "aliased"})

    assert chunk.text == "aliased"


def table_cells_row(**overrides: object) -> dict:
    """One row exactly as womblex's `TABLE_CELLS_SCHEMA` writes it.

    Every column, real spelling: `parent_elem_order` (not `elem_order`), `row`/`col`
    (not `row_index`/`col_index`), and no currency column at all. The previous
    fixtures here invented those names, which is why the suite stayed green while
    the mapping raised on every real row.
    """
    return {
        "source_hash": SOURCE_HASH,
        "parent_elem_order": 2,
        "row": 0,
        "col": 1,
        "value": "80000",
        "rowspan": 1,
        "colspan": 1,
        "value_type": "text",
        **overrides,
    }


def test_table_cell_maps_a_real_womblex_table_cells_row() -> None:
    cell = map_table_cell(SOURCE_HASH, table_cells_row(value="$80,000.00"))

    assert cell.documentId == SOURCE_HASH
    assert cell.elementOrder == 2
    assert (cell.rowIndex, cell.columnIndex) == (0, 1)
    assert cell.rawValue == "$80,000.00"
    assert cell.isCurrency is True
    # `TABLE_CELLS_SCHEMA` carries no page column; the cell's page is the parent
    # element's, which this shard does not join. Absent, not zero.
    assert cell.page is None


def test_table_cell_keeps_the_value_verbatim() -> None:
    # womblex reads with dtype=str so "1,234" stays "1,234"; the seam must not
    # coerce it, or provenance back to the source cell stops matching.
    cell = map_table_cell(SOURCE_HASH, table_cells_row(value="AUD 1,234.50"))

    assert cell.rawValue == "AUD 1,234.50"


@pytest.mark.parametrize(
    "value",
    [
        "$80,000.00",
        "$80000",
        "A$1,234.56",
        "AU$99.95",
        "US$40",
        "AUD 1,234.50",
        "1,234.50 AUD",
        "aud 12.00",
        "€1.234",
        "£99",
        "($1,234.56)",
        "$ 1,234.56",
        "-$500.00",
        # A code and a symbol together — common on Australian tender pricing.
        "AUD $1,234.56",
        "$1,234.56 AUD",
    ],
)
def test_table_cell_flags_an_explicitly_marked_currency_value(value: str) -> None:
    assert map_table_cell(SOURCE_HASH, table_cells_row(value=value)).isCurrency is True


@pytest.mark.parametrize(
    "value",
    [
        # ADR-0016: a bare number is not currency. redline cannot tell a price from
        # a quantity or a weighting without a marker, and summing them is worse
        # than showing a gap.
        "80000",
        "1,234.50",
        "12",
        "0",
        # Headers and prose that merely mention a currency.
        "Price (AUD)",
        "Total cost in AUD",
        "12 AUD each",
        "$ per unit",
        # Not values at all.
        "",
        "   ",
        "N/A",
        "TBC",
        "Included",
    ],
)
def test_table_cell_does_not_flag_an_unmarked_or_non_numeric_value(value: str) -> None:
    assert map_table_cell(SOURCE_HASH, table_cells_row(value=value)).isCurrency is False


def test_table_cell_honours_a_value_type_that_declares_currency() -> None:
    # Unpopulated at womblex v0.2.0 (always "text"), but the column exists: a
    # future openpyxl-based reader upgrades the signal with no redline change.
    cell = map_table_cell(SOURCE_HASH, table_cells_row(value="80000", value_type="currency"))

    assert cell.isCurrency is True


def test_table_cell_honours_a_sheet_cell_number_format_that_declares_currency() -> None:
    # `number_format` lives on ELEMENT_SCHEMA (sheet_cell elements), not on
    # table_cells, and womblex v0.2.0 leaves it unset — honoured, never relied on.
    cell = map_table_cell(
        SOURCE_HASH,
        {"elem_order": 4, "row": 1, "col": 2, "value": "1234.5", "number_format": '"$"#,##0.00'},
    )

    assert cell.isCurrency is True


def test_table_cell_maps_a_sheet_cell_element_row() -> None:
    # A sheet_cell element spells its ordinal `elem_order` and carries a page;
    # both spellings map, which is what lets one mapping serve both shards.
    cell = map_table_cell(
        SOURCE_HASH,
        {"elem_order": 7, "page": 3, "row": 5, "col": 0, "value": "$12.00"},
    )

    assert (cell.elementOrder, cell.page) == (7, 3)
    assert (cell.rowIndex, cell.columnIndex) == (5, 0)
    assert cell.isCurrency is True


def test_table_cell_without_a_parent_elem_order_is_a_schema_error() -> None:
    row = table_cells_row()
    del row["parent_elem_order"]

    with pytest.raises(ShardSchemaError):
        map_table_cell(SOURCE_HASH, row)


def test_table_cell_without_a_column_index_is_a_schema_error() -> None:
    row = table_cells_row()
    del row["col"]

    with pytest.raises(ShardSchemaError):
        map_table_cell(SOURCE_HASH, row)


def test_table_cell_maps_a_zero_row_and_column() -> None:
    # `_require` rejects None but must not reject a falsy 0 — the top-left cell of
    # every table is (0, 0), which an `or`-based default would silently drop.
    cell = map_table_cell(SOURCE_HASH, table_cells_row(row=0, col=0))

    assert (cell.rowIndex, cell.columnIndex) == (0, 0)


def test_extraction_orders_chunks_by_chunk_index() -> None:
    rows = ShardRows(
        source_hash=SOURCE_HASH,
        elements=[{"elem_order": 0, "page": 1, "text": "e"}],
        chunks=[
            {"chunk_index": 2, "text": "third"},
            {"chunk_index": 0, "text": "first"},
            {"chunk_index": 1, "text": "second"},
        ],
    )

    extraction = map_document_extraction(rows)

    assert [chunk.chunkId for chunk in extraction.chunks] == [
        f"{SOURCE_HASH}:0",
        f"{SOURCE_HASH}:1",
        f"{SOURCE_HASH}:2",
    ]


def test_embeddings_join_chunks_and_declare_the_model() -> None:
    rows = ShardRows(
        source_hash=SOURCE_HASH,
        elements=[{"elem_order": 0, "text": "e"}],
        chunks=[{"chunk_index": 0, "text": "c0"}, {"chunk_index": 1, "text": "c1"}],
        embeddings=[
            {"chunk_index": 1, "embedding": [0.4, 0.3]},
            {"chunk_index": 0, "embedding": [0.1, 0.2]},
        ],
        model="kanon-2-embedder",
    )

    embeddings = map_document_embeddings(rows)

    assert isinstance(embeddings, DocumentEmbeddings)
    assert embeddings.model == "kanon-2-embedder"
    assert embeddings.dimensions == 2
    # Ordered by chunk_index, joinable on (source_hash, chunk_index).
    assert [(v.chunkId, v.chunkIndex) for v in embeddings.vectors] == [
        (f"{SOURCE_HASH}:0", 0),
        (f"{SOURCE_HASH}:1", 1),
    ]
    for vector in embeddings.vectors:
        assert math.isclose(math.sqrt(sum(x * x for x in vector.values)), 1.0, rel_tol=1e-9)


def test_absent_embed_stage_maps_to_none_not_an_empty_payload() -> None:
    # A document with no *.embeddings.parquet is the NOT_FOUND path (ADR-0014),
    # never an empty DocumentEmbeddings.
    rows = ShardRows(
        source_hash=SOURCE_HASH,
        elements=[{"elem_order": 0, "text": "e"}],
        chunks=[{"chunk_index": 0, "text": "c"}],
        embeddings=[],
        model=None,
    )

    assert map_document_embeddings(rows) is None


def test_embeddings_without_a_declared_model_are_refused() -> None:
    # Vectors a consumer cannot confirm are in the query's space are worse than
    # absent ones: refuse at the seam rather than rank noise downstream.
    rows = ShardRows(
        source_hash=SOURCE_HASH,
        elements=[{"elem_order": 0, "text": "e"}],
        chunks=[{"chunk_index": 0, "text": "c"}],
        embeddings=[{"chunk_index": 0, "embedding": [0.1, 0.2]}],
        model=None,
    )

    with pytest.raises(ShardSchemaError):
        map_document_embeddings(rows)


def test_group_rows_fans_batched_shards_out_per_source_hash() -> None:
    other = "aaaa000011112222"
    documents = group_rows_by_document(
        elements=[
            {"source_hash": SOURCE_HASH, "elem_order": 0, "text": "a"},
            {"source_hash": other, "elem_order": 0, "text": "b"},
        ],
        chunks=[
            {"source_hash": SOURCE_HASH, "chunk_index": 0, "text": "ca"},
            {"source_hash": other, "chunk_index": 0, "text": "cb"},
        ],
        table_cells=[],
        embeddings=[{"source_hash": SOURCE_HASH, "chunk_index": 0, "embedding": [1.0]}],
        models_by_source_hash={SOURCE_HASH: "kanon-2-embedder"},
    )

    by_hash = {rows.source_hash: rows for rows in documents}
    assert set(by_hash) == {SOURCE_HASH, other}
    # Only the document that appeared in the embeddings shard carries a model.
    assert by_hash[SOURCE_HASH].model == "kanon-2-embedder"
    assert by_hash[other].model is None
    assert len(by_hash[other].embeddings) == 0


def test_group_rows_ignores_orphan_vectors_with_no_structural_content() -> None:
    # An embedding with no element/chunk to attach to is not a document we serve.
    documents = group_rows_by_document(
        elements=[],
        chunks=[],
        table_cells=[],
        embeddings=[{"source_hash": SOURCE_HASH, "chunk_index": 0, "embedding": [1.0]}],
        models_by_source_hash={SOURCE_HASH: "kanon-2-embedder"},
    )

    assert documents == []
