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


def test_table_cell_maps_currency_flag_and_indices() -> None:
    cell = map_table_cell(
        SOURCE_HASH,
        {
            "elem_order": 2,
            "page": 1,
            "row_index": 0,
            "col_index": 1,
            "raw_value": "80000",
            "is_currency": True,
        },
    )

    assert cell.documentId == SOURCE_HASH
    assert (cell.rowIndex, cell.columnIndex) == (0, 1)
    assert cell.rawValue == "80000"
    assert cell.isCurrency is True


@pytest.mark.parametrize("flag,expected", [(1, True), (0, False), ("true", True), ("no", False)])
def test_table_cell_normalises_a_non_bool_currency_flag(flag: object, expected: bool) -> None:
    cell = map_table_cell(
        SOURCE_HASH,
        {"elem_order": 0, "row_index": 0, "col_index": 0, "raw_value": "1", "is_currency": flag},
    )

    assert cell.isCurrency is expected


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
