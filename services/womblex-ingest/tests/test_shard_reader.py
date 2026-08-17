"""Thread 37b — the womblex-schema → JSON mapping, proven on plain row dicts.

These tests exercise `shard_reader.py` — the one place that understands womblex's
real Parquet schema — with hand-built row dicts, so the schema *contract* is
provable without pyarrow, a real shard, or the womblex engine installed. The
Parquet-decode + storage-read side of the binding is covered by
`test_real_extractor.py` (pyarrow-gated).
"""

from __future__ import annotations

import pytest

from womblex_ingest.shard_reader import (
    ShardRows,
    ShardSchemaError,
    group_rows_by_document,
    map_chunk,
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


# Thread 61 (V1a) — non-text element kinds. womblex's `Element.text` is `str |
# None`; only the text-bearing kinds (TEXT_KINDS) populate it, and `table`,
# `image`, `figure`, `form`, `page_break`, `sheet_meta` and `sheet_cell` all
# serialise `text: None`. `map_element` must map every element rather than
# `_require` a text it will never find — one such element raising would lose the
# whole document's extraction, and every real tender carries tables. The element
# is kept (never dropped) so `elementOrder` provenance stays contiguous; the
# visible text falls back to `alt_text` (ELEMENT_SCHEMA carries it for
# `image`/`figure`) then to `""`.


def test_non_text_element_with_null_text_maps_to_empty_string_not_a_raise() -> None:
    # A `table` element carries no text of its own (its cells are a sibling
    # shard). The row still maps — losing it would break elementOrder contiguity
    # and, via `map_document_extraction`, lose the whole document.
    element = map_element(SOURCE_HASH, {"elem_order": 4, "kind": "table", "text": None})

    assert element.elementOrder == 4
    assert element.text == ""


def test_non_text_element_with_a_missing_text_key_maps_to_empty_string() -> None:
    # womblex writes the column, but a producer/fixture that omits it entirely
    # must map identically to an explicit `None` — the absence is the same fact.
    element = map_element(SOURCE_HASH, {"elem_order": 5, "kind": "page_break"})

    assert element.text == ""


def test_image_element_falls_back_to_alt_text() -> None:
    # ELEMENT_SCHEMA carries `alt_text` for `image`/`figure`; it is the only
    # human-readable string such an element has, so it is the map's text when
    # `text` is null. This is what BuildDocumentMap renders for a figure.
    element = map_element(
        SOURCE_HASH,
        {"elem_order": 6, "kind": "image", "text": None, "alt_text": "Org chart"},
    )

    assert element.text == "Org chart"


def test_text_is_preferred_over_alt_text_when_both_are_present() -> None:
    # A text-bearing element that also happens to carry alt_text keeps its own
    # text; alt_text is strictly the fallback, never an override.
    element = map_element(
        SOURCE_HASH,
        {"elem_order": 7, "kind": "caption", "text": "Figure 1", "alt_text": "ignored"},
    )

    assert element.text == "Figure 1"


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


def test_chunk_carries_the_element_range_it_was_cut_from() -> None:
    # Chunk element addressing (delivery-plan): a narrative chunk's start_char/
    # end_char is what a money span's narrative locus resolves against.
    chunk = map_chunk(
        SOURCE_HASH,
        {
            "chunk_index": 2,
            "text": "body",
            "content_type": "narrative",
            "start_char": 120,
            "end_char": 480,
        },
    )

    assert chunk.contentType == "narrative"
    assert chunk.startChar == 120
    assert chunk.endChar == 480
    assert chunk.elementOrder is None


def test_table_chunk_carries_its_anchor_element_order() -> None:
    # A table chunk's start_char/end_char are into table markdown, not the
    # narrative — null on the shard row (CHUNKS_SCHEMA), and elem_order is the
    # one anchor it carries (the table element it was cut from).
    chunk = map_chunk(
        SOURCE_HASH,
        {"chunk_index": 0, "text": "| a | b |", "content_type": "table", "elem_order": 4},
    )

    assert chunk.contentType == "table"
    assert chunk.startChar is None
    assert chunk.endChar is None
    assert chunk.elementOrder == 4


def test_chunk_content_type_defaults_to_narrative_when_absent() -> None:
    chunk = map_chunk(SOURCE_HASH, {"chunk_index": 0, "text": "body"})

    assert chunk.contentType == "narrative"


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
        # A bare number is not currency. redline cannot tell a price from
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


def test_extraction_maps_every_element_including_non_text_kinds() -> None:
    # Thread 61 exit test: a shard whose elements include `table`, `image` and
    # `page_break` maps to a DocumentExtraction with every element present and no
    # raise. Before this, the `table` row (the only kind that has `table_cells`
    # children) would raise `ShardSchemaError` on its null text and lose the whole
    # document — taking its pricing with it, on exactly the table-bearing tenders
    # redline exists to read.
    rows = ShardRows(
        source_hash=SOURCE_HASH,
        elements=[
            {"elem_order": 0, "kind": "heading", "page": 1, "text": "Pricing schedule"},
            {"elem_order": 1, "kind": "table", "page": 1, "text": None},
            {"elem_order": 2, "kind": "image", "page": 1, "text": None, "alt_text": "Logo"},
            {"elem_order": 3, "kind": "page_break", "page": 1, "text": None},
        ],
        chunks=[{"chunk_index": 0, "text": "c"}],
        table_cells=[table_cells_row(parent_elem_order=1, value="$80,000.00")],
    )

    extraction = map_document_extraction(rows)

    # Every element present, in order, elementOrder contiguous.
    assert [e.elementOrder for e in extraction.elements] == [0, 1, 2, 3]
    assert [e.text for e in extraction.elements] == [
        "Pricing schedule",
        "",  # table: null text → ""
        "Logo",  # image: alt_text fallback
        "",  # page_break: null text → ""
    ]
    # The table's cell survives because its parent element no longer kills the doc.
    assert [c.elementOrder for c in extraction.tableCells] == [1]
    assert extraction.tableCells[0].isCurrency is True


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
    )

    by_hash = {rows.source_hash: rows for rows in documents}
    assert set(by_hash) == {SOURCE_HASH, other}


def test_group_rows_ignores_documents_with_no_structural_content() -> None:
    documents = group_rows_by_document(
        elements=[],
        chunks=[],
        table_cells=[{"source_hash": SOURCE_HASH, "parent_elem_order": 0, "row": 0, "col": 0, "value": "x"}],
    )

    assert documents == []
