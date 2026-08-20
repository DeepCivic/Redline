"""The run-scoped, schema-carrying shard read.

Proven two ways. Most tests write small Parquet shards with pyarrow so a case is
readable beside its assertion; the last section reads the **real** corpus fixture
(`tests/fixtures/run-throsby-demo/`) so the served column names are womblex's
actual ones rather than ones this suite and the implementation agree on between
themselves.
"""

from __future__ import annotations

import io
from decimal import Decimal
from pathlib import Path
from typing import Dict, List

import pytest

from tests.conftest import FakeObjectStorage
from womblex_ingest.shards import (
    ASSETS,
    UNVERSIONED_RUN_ID,
    AssetNotReadable,
    UnknownAsset,
    list_runs,
    read_shard,
)

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "run-throsby-demo"


def write_parquet(rows: List[Dict], schema: "pa.Schema") -> bytes:
    buffer = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), buffer)
    return buffer.getvalue()


ELEMENTS_SCHEMA = pa.schema(
    [
        ("source_hash", pa.string()),
        ("elem_order", pa.int32()),
        ("page", pa.int32()),
        ("text", pa.string()),
    ]
)


def element_shard(source_hash: str, texts: List[str]) -> bytes:
    return write_parquet(
        [
            {"source_hash": source_hash, "elem_order": order, "page": 1, "text": text}
            for order, text in enumerate(texts)
        ],
        ELEMENTS_SCHEMA,
    )


# ── run discovery ────────────────────────────────────────────────────────────


def test_runs_are_listed_newest_first() -> None:
    storage = FakeObjectStorage()
    for run in ("run-20260101T000000Z", "run-20260301T000000Z", "run-20260201T000000Z"):
        storage.put_object(
            f"proc/corpus-1/{run}/documents/batch-0001.elements.parquet",
            element_shard("doc-a", ["one"]),
            "application/octet-stream",
        )

    runs = list_runs(storage, "corpus-1")

    assert [run.run_id for run in runs] == [
        "run-20260301T000000Z",
        "run-20260201T000000Z",
        "run-20260101T000000Z",
    ]
    assert all(run.versioned for run in runs)


def test_a_runs_path_segment_is_read_as_well_as_a_bare_run_directory() -> None:
    """Both layouts womblex's store URI can produce resolve to the same run id.

    `<root>/<run_id>/documents/` is what the engine writes; a deployment whose
    store URI adds a `runs/` segment produces `<root>/runs/<run_id>/documents/`.
    Reading only one spelling drops every shard of the other into the
    unversioned bucket, where runs merge — the failure run-scoping exists to
    prevent.
    """
    storage = FakeObjectStorage()
    storage.put_object(
        "proc/corpus-1/runs/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard("doc-a", ["one"]),
        "application/octet-stream",
    )

    runs = list_runs(storage, "corpus-1")

    assert [run.run_id for run in runs] == ["run-20260101T000000Z"]


def test_a_flat_layout_is_surfaced_as_one_addressable_unversioned_run() -> None:
    storage = FakeObjectStorage()
    storage.put_object(
        "proc/corpus-1/documents/batch-0001.elements.parquet",
        element_shard("doc-a", ["one"]),
        "application/octet-stream",
    )

    runs = list_runs(storage, "corpus-1")

    assert [run.run_id for run in runs] == [UNVERSIONED_RUN_ID]
    assert runs[0].versioned is False


def test_a_corpus_with_no_shards_lists_no_runs() -> None:
    assert list_runs(FakeObjectStorage(), "corpus-nothing") == []


# ── the read is run-scoped ───────────────────────────────────────────────────


def test_two_runs_of_one_corpus_each_serve_their_own_rows() -> None:
    """Blocker 1, at the route rather than inside the extractor.

    The same document processed twice must not come back twice. Merging runs
    doubles every row and makes `elem_order` identify nothing — individually
    plausible rows, collectively wrong.
    """
    storage = FakeObjectStorage()
    storage.put_object(
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard("doc-a", ["first run"]),
        "application/octet-stream",
    )
    storage.put_object(
        "proc/corpus-1/run-20260201T000000Z/documents/batch-0001.elements.parquet",
        element_shard("doc-a", ["second run"]),
        "application/octet-stream",
    )

    first = read_shard(storage, "corpus-1", "run-20260101T000000Z", "elements")
    second = read_shard(storage, "corpus-1", "run-20260201T000000Z", "elements")

    assert [row["text"] for row in first.rows] == ["first run"]
    assert [row["text"] for row in second.rows] == ["second run"]


def test_an_unknown_run_reads_empty_rather_than_falling_back_to_another_run() -> None:
    storage = FakeObjectStorage()
    storage.put_object(
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard("doc-a", ["first run"]),
        "application/octet-stream",
    )

    page = read_shard(storage, "corpus-1", "run-19990101T000000Z", "elements")

    assert page.rows == []
    assert page.available == 0


# ── the columns are womblex's ────────────────────────────────────────────────


def test_column_names_and_values_are_womblexs_own() -> None:
    storage = FakeObjectStorage()
    storage.put_object(
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard("doc-a", ["verbatim text"]),
        "application/octet-stream",
    )

    page = read_shard(storage, "corpus-1", "run-20260101T000000Z", "elements")

    assert [column.name for column in page.columns] == [
        "source_hash",
        "elem_order",
        "page",
        "text",
    ]
    assert page.rows[0]["source_hash"] == "doc-a"
    # The camelCase read model is not what this seam serves.
    assert "documentId" not in page.rows[0]
    assert "elementOrder" not in page.rows[0]


def test_column_types_are_reported_for_schema_discovery() -> None:
    storage = FakeObjectStorage()
    storage.put_object(
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard("doc-a", ["one"]),
        "application/octet-stream",
    )

    page = read_shard(storage, "corpus-1", "run-20260101T000000Z", "elements")
    types = {column.name: column.type for column in page.columns}

    assert types["source_hash"] == "string"
    assert types["elem_order"] == "int32"


# ── value fidelity ───────────────────────────────────────────────────────────


MONEY_SCHEMA = pa.schema(
    [
        ("source_hash", pa.string()),
        ("text", pa.string()),
        ("value", pa.decimal128(38, 4)),
        ("negative", pa.bool_()),
    ]
)


def test_a_decimal_amount_survives_as_its_exact_digits() -> None:
    """A money span's value is decimal128(38,4) and must not become a float.

    `50000.0001` is representable exactly as a decimal and not as a float64;
    serialising through one silently rewrites the amount. The whole point of
    preferring a span over parsing a string is that the span is exact.
    """
    storage = FakeObjectStorage()
    storage.put_object(
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.money_spans.parquet",
        write_parquet(
            [
                {
                    "source_hash": "doc-a",
                    "text": "$50 000.0001",
                    "value": Decimal("50000.0001"),
                    "negative": False,
                }
            ],
            MONEY_SCHEMA,
        ),
        "application/octet-stream",
    )

    page = read_shard(storage, "corpus-1", "run-20260101T000000Z", "money_spans")

    assert page.rows[0]["value"] == "50000.0001"
    assert page.rows[0]["text"] == "$50 000.0001"


# ── document filtering ───────────────────────────────────────────────────────


def two_document_run(storage: FakeObjectStorage) -> None:
    storage.put_object(
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard("doc-a", ["a one", "a two"]),
        "application/octet-stream",
    )
    storage.put_object(
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0002.elements.parquet",
        element_shard("doc-b", ["b one"]),
        "application/octet-stream",
    )


def test_a_document_filter_matches_the_assets_identity_column() -> None:
    storage = FakeObjectStorage()
    two_document_run(storage)

    page = read_shard(
        storage, "corpus-1", "run-20260101T000000Z", "elements", document_id="doc-a"
    )

    assert [row["text"] for row in page.rows] == ["a one", "a two"]


GRAPH_SCHEMA = pa.schema(
    [
        ("document_id", pa.string()),
        ("source_id", pa.string()),
        ("target_id", pa.string()),
        ("relation", pa.string()),
    ]
)


def test_a_document_filter_also_matches_the_graph_shards_spelling() -> None:
    """Graph shards key on `document_id`; every other family on `source_hash`.

    The two carry the same value, so a caller holding one id must not have to
    know which spelling the asset it is reading happens to use.
    """
    storage = FakeObjectStorage()
    storage.put_object(
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.graph_edges.parquet",
        write_parquet(
            [
                {
                    "document_id": "doc-a",
                    "source_id": "e1",
                    "target_id": "e2",
                    "relation": "mentions",
                },
                {
                    "document_id": "doc-b",
                    "source_id": "e3",
                    "target_id": "e4",
                    "relation": "mentions",
                },
            ],
            GRAPH_SCHEMA,
        ),
        "application/octet-stream",
    )

    page = read_shard(
        storage, "corpus-1", "run-20260101T000000Z", "graph_edges", document_id="doc-a"
    )

    assert [row["source_id"] for row in page.rows] == ["e1"]


# ── paging is honest ─────────────────────────────────────────────────────────


def test_a_capped_read_reports_what_it_left_behind() -> None:
    storage = FakeObjectStorage()
    two_document_run(storage)

    page = read_shard(storage, "corpus-1", "run-20260101T000000Z", "elements", limit=2)

    assert page.returned == 2
    assert page.available == 3
    assert page.truncated is True


def test_an_offset_continues_where_the_previous_page_stopped() -> None:
    storage = FakeObjectStorage()
    two_document_run(storage)

    page = read_shard(
        storage, "corpus-1", "run-20260101T000000Z", "elements", limit=2, offset=2
    )

    assert [row["text"] for row in page.rows] == ["b one"]
    assert page.truncated is False


def test_rows_are_ordered_stably_across_shards() -> None:
    storage = FakeObjectStorage()
    two_document_run(storage)

    first = read_shard(storage, "corpus-1", "run-20260101T000000Z", "elements")
    second = read_shard(storage, "corpus-1", "run-20260101T000000Z", "elements")

    assert [row["text"] for row in first.rows] == [row["text"] for row in second.rows]
    assert [row["text"] for row in first.rows] == ["a one", "a two", "b one"]


# ── refusals ─────────────────────────────────────────────────────────────────


def test_an_unknown_asset_is_refused_by_name() -> None:
    with pytest.raises(UnknownAsset):
        read_shard(FakeObjectStorage(), "corpus-1", "run-1", "not_an_asset")


def test_embeddings_are_catalogued_but_not_served() -> None:
    """The vectors are real and useless here: womblex ships no index, so nothing
    ranks them, and one document's vectors would dwarf every other payload.
    Refusing by name beats returning megabytes a caller cannot act on."""
    assert "embeddings" in ASSETS
    assert ASSETS["embeddings"].readable is False

    with pytest.raises(AssetNotReadable):
        read_shard(FakeObjectStorage(), "corpus-1", "run-1", "embeddings")


# ── against the real corpus ──────────────────────────────────────────────────


def load_fixture_run(storage: FakeObjectStorage, run_id: str = "run-throsby-demo") -> None:
    """Stage the committed real-run shards under a corpus prefix."""
    for path in sorted(FIXTURE_ROOT.rglob("*.parquet")):
        relative = path.relative_to(FIXTURE_ROOT)
        storage.put_object(
            f"proc/throsby/{run_id}/{relative.as_posix()}",
            path.read_bytes(),
            "application/octet-stream",
        )


@pytest.mark.parametrize(
    ("asset", "expected_columns"),
    [
        ("elements", ["source_hash", "elem_order", "kind", "page", "text"]),
        ("form_fields", ["source_hash", "parent_elem_order", "field_index", "name", "value", "field_type"]),
        ("graph_edges", ["document_id", "source_id", "target_id", "relation"]),
        ("money_spans", ["source_hash", "locus", "text", "value", "currency", "multiplier", "negative"]),
        ("entities", ["document_id", "entity_id", "entity_label", "name", "chunk_index"]),
        ("chunks", ["source_hash", "chunk_index", "text", "start_char", "end_char", "content_type"]),
        ("manifest", ["source_hash", "doc_id", "filename", "status"]),
    ],
)
def test_the_real_corpus_serves_womblexs_own_column_names(
    asset: str, expected_columns: List[str]
) -> None:
    """The columns this seam serves are the engine's, checked against real shards.

    Column names have been invented here before — `elem_order` / `col_index` /
    `is_currency` on table cells — and raised on every real row while the suite
    stayed green. This is the guard that fails instead.
    """
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    page = read_shard(storage, "throsby", "run-throsby-demo", asset)
    served = {column.name for column in page.columns}

    assert set(expected_columns) <= served


def test_the_real_corpus_serves_real_rows() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    assert read_shard(storage, "throsby", "run-throsby-demo", "elements").available == 24
    assert read_shard(storage, "throsby", "run-throsby-demo", "chunks").available == 4
    assert read_shard(storage, "throsby", "run-throsby-demo", "form_fields").available == 2
    assert read_shard(storage, "throsby", "run-throsby-demo", "graph_edges").available == 156
    assert read_shard(storage, "throsby", "run-throsby-demo", "entities").available == 34
    assert read_shard(storage, "throsby", "run-throsby-demo", "money_spans").available == 2


def test_the_real_corpus_table_cells_are_empty_not_missing() -> None:
    """The fixture's `table_cells` shard exists and holds nothing.

    An empty asset must still report its columns, or a caller cannot tell
    "no rows" from "no such asset" — the distinction FR-1.5 turns on.
    """
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    page = read_shard(storage, "throsby", "run-throsby-demo", "table_cells")

    assert page.rows == []
    assert "parent_elem_order" in {column.name for column in page.columns}


def test_the_real_corpus_money_values_keep_their_exact_digits() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    page = read_shard(storage, "throsby", "run-throsby-demo", "money_spans")

    assert [row["value"] for row in page.rows] == ["10000.0000", "50000.0000"]
    assert all(isinstance(row["value"], str) for row in page.rows)


def test_two_real_runs_of_one_corpus_stay_separate() -> None:
    """The regression the fixture alone cannot show, staged from it.

    One real run, copied under two run ids: reading either must serve the
    document once, not twice.
    """
    storage = FakeObjectStorage()
    load_fixture_run(storage, "run-20260101T000000Z")
    load_fixture_run(storage, "run-20260201T000000Z")

    assert len(list_runs(storage, "throsby")) == 2
    for run_id in ("run-20260101T000000Z", "run-20260201T000000Z"):
        assert read_shard(storage, "throsby", run_id, "elements").available == 24


# ── the HTTP surface ─────────────────────────────────────────────────────────


def shard_client(storage: FakeObjectStorage):
    from fastapi.testclient import TestClient

    from tests.conftest import StubExtractor
    from womblex_ingest.main import build_app

    return TestClient(
        build_app(storage=storage, extractor=StubExtractor(), bucket="redline")
    )


def test_the_run_route_lists_a_corpuss_runs_newest_first() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage, "run-20260101T000000Z")
    load_fixture_run(storage, "run-20260201T000000Z")

    body = shard_client(storage).get("/runs/throsby").json()

    assert [run["runId"] for run in body["runs"]] == [
        "run-20260201T000000Z",
        "run-20260101T000000Z",
    ]


def test_a_corpus_with_no_runs_is_not_found_rather_than_empty() -> None:
    response = shard_client(FakeObjectStorage()).get("/runs/nothing-here")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_the_shard_route_serves_rows_and_their_schema() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    body = shard_client(storage).get(
        "/runs/throsby/run-throsby-demo/shards/form_fields"
    ).json()

    assert {column["name"] for column in body["columns"]} >= {
        "source_hash",
        "field_index",
        "name",
        "value",
    }
    assert body["available"] == 2
    assert body["truncated"] is False


def test_the_shard_route_caps_and_says_so() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    body = shard_client(storage).get(
        "/runs/throsby/run-throsby-demo/shards/graph_edges?limit=10"
    ).json()

    assert body["returned"] == 10
    assert body["available"] == 156
    assert body["truncated"] is True


def test_the_shard_route_filters_by_document() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage)
    known = read_shard(storage, "throsby", "run-throsby-demo", "manifest").rows[0]

    body = shard_client(storage).get(
        f"/runs/throsby/run-throsby-demo/shards/chunks?documentId={known['source_hash']}"
    ).json()

    assert body["available"] == 4


def test_the_shard_route_refuses_an_unknown_asset_by_name() -> None:
    response = shard_client(FakeObjectStorage()).get(
        "/runs/throsby/run-1/shards/not_an_asset"
    )

    assert response.status_code == 404
    assert "not_an_asset" in response.json()["error"]["message"]


def test_the_shard_route_refuses_embeddings_with_a_reason() -> None:
    response = shard_client(FakeObjectStorage()).get(
        "/runs/throsby/run-1/shards/embeddings"
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "ASSET_NOT_READABLE"


def test_the_asset_route_catalogues_what_the_run_holds() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    body = shard_client(storage).get("/runs/throsby/run-throsby-demo/assets").json()
    present = {asset["name"]: asset for asset in body["assets"]}

    assert present["graph_edges"]["present"] is True
    assert present["elements"]["present"] is True
    # Catalogued, present in the run, and still not served.
    assert present["embeddings"]["readable"] is False
    assert present["enrichment_meta"]["present"] is True
