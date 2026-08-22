"""Shape aggregation: how big a corpus, run or document is, without reading it.

The property every test here defends is cost. A client asks for shape so it can
size a retrieval *before* making it, which is only worth doing if asking is
cheaper than reading — so the suite proves what was decoded, not only what was
returned. `test_a_run_scope_decodes_no_rows_at_all` and
`test_a_document_scope_never_requests_a_body_column` are the two that matter:
they fail the moment an implementation reaches for `read_table` where a footer
would do, or projects a column carrying document text.

Counts and tallies are proven against the real corpus fixture as well as against
shards written here, so the numbers are womblex's rather than ones this suite and
the implementation agree on between themselves.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Dict, List

import pytest

from tests.conftest import FakeObjectStorage
from womblex_ingest.shape import MAX_TALLY_VALUES, read_shape

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "run-throsby-demo"

# Every column below carries document text. A shape read that projects one of
# these has stopped being cheap and has put body on the metadata side of the
# split — both failures the projection guards exist to catch.
BODY_COLUMNS = {"text", "alt_text", "value", "vector", "prop_value", "title", "name"}


def write_parquet(rows: List[Dict], schema: "pa.Schema") -> bytes:
    buffer = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), buffer)
    return buffer.getvalue()


ELEMENTS_SCHEMA = pa.schema(
    [
        ("source_hash", pa.string()),
        ("elem_order", pa.int32()),
        ("kind", pa.string()),
        ("extractor", pa.string()),
        ("page", pa.int32()),
        ("text", pa.string()),
    ]
)

MANIFEST_SCHEMA = pa.schema(
    [
        ("source_hash", pa.string()),
        ("filename", pa.string()),
        ("ext", pa.string()),
        ("status", pa.string()),
        ("extraction_method", pa.string()),
    ]
)


def element_shard(rows: List[Dict]) -> bytes:
    return write_parquet(rows, ELEMENTS_SCHEMA)


def element(source_hash: str, order: int, kind: str, page: int) -> Dict:
    return {
        "source_hash": source_hash,
        "elem_order": order,
        "kind": kind,
        "extractor": "pdf_text",
        "page": page,
        "text": f"{kind} {order}",
    }


def manifest_shard(source_hashes: List[str]) -> bytes:
    return write_parquet(
        [
            {
                "source_hash": source_hash,
                "filename": f"{source_hash}.pdf",
                "ext": ".pdf",
                "status": "ok",
                "extraction_method": "pdf_text",
            }
            for source_hash in source_hashes
        ],
        MANIFEST_SCHEMA,
    )


def stage(storage: FakeObjectStorage, key: str, body: bytes) -> None:
    storage.put_object(key, body, "application/octet-stream")


def load_fixture_run(
    storage: FakeObjectStorage, run_id: str = "run-throsby-demo"
) -> None:
    """Stage the committed real womblex run under a corpus prefix."""
    for path in sorted(FIXTURE_ROOT.rglob("*.parquet")):
        relative = path.relative_to(FIXTURE_ROOT)
        stage(storage, f"proc/throsby/{run_id}/{relative.as_posix()}", path.read_bytes())


def asset_named(shape, run_id: str, asset: str):
    run = next(run for run in shape.runs if run.run_id == run_id)
    return next(entry for entry in run.assets if entry.name == asset)


class ReadTableSpy:
    """Records every `read_table` call so a test can assert what was decoded."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls: List[object] = []
        original = pq.read_table

        def spy(source, **kwargs):
            self.calls.append(kwargs.get("columns"))
            return original(source, **kwargs)

        monkeypatch.setattr(pq, "read_table", spy)


# ── run scope ────────────────────────────────────────────────────────────────


def test_a_run_reports_row_counts_for_every_asset_it_holds() -> None:
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard([element("doc-a", 0, "paragraph", 1), element("doc-a", 1, "heading", 1)]),
    )
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001._manifest.parquet",
        manifest_shard(["doc-a"]),
    )

    shape = read_shape(storage, "corpus-1", run_id="run-20260101T000000Z")

    assert asset_named(shape, "run-20260101T000000Z", "elements").rows == 2
    assert asset_named(shape, "run-20260101T000000Z", "elements").present is True


def test_a_run_scope_decodes_no_rows_at_all(monkeypatch: pytest.MonkeyPatch) -> None:
    """Counts come from the Parquet footer, so asking the size reads no rows."""
    storage = FakeObjectStorage()
    load_fixture_run(storage)
    spy = ReadTableSpy(monkeypatch)

    read_shape(storage, "throsby", run_id="run-throsby-demo")

    assert spy.calls == []


def test_an_absent_asset_is_reported_as_absent_not_omitted() -> None:
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard([element("doc-a", 0, "paragraph", 1)]),
    )

    table_cells = asset_named(
        read_shape(storage, "corpus-1", run_id="run-20260101T000000Z"),
        "run-20260101T000000Z",
        "table_cells",
    )

    assert table_cells.present is False
    assert table_cells.rows == 0
    assert table_cells.columns == []


def test_an_asset_redline_refuses_to_serve_reports_no_count() -> None:
    """`embeddings` is catalogued and refused, so its size is not reported either.

    `present` already tells a client the run holds vectors; a row count would be
    redline answering about rows it will not serve.
    """
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.embeddings.parquet",
        element_shard([element("doc-a", 0, "paragraph", 1)]),
    )

    embeddings = asset_named(
        read_shape(storage, "corpus-1", run_id="run-20260101T000000Z"),
        "run-20260101T000000Z",
        "embeddings",
    )

    assert embeddings.present is True
    assert embeddings.readable is False
    assert embeddings.rows is None


def test_a_run_reports_its_document_count_from_the_manifest() -> None:
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001._manifest.parquet",
        manifest_shard(["doc-a", "doc-b", "doc-c"]),
    )

    shape = read_shape(storage, "corpus-1", run_id="run-20260101T000000Z")

    assert shape.runs[0].documents == 3


# ── corpus scope ─────────────────────────────────────────────────────────────


def test_two_runs_of_one_corpus_are_counted_separately() -> None:
    """Merged counts would make the corpus look twice its size and identify nothing."""
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard([element("doc-a", 0, "paragraph", 1)]),
    )
    stage(
        storage,
        "proc/corpus-1/run-20260201T000000Z/documents/batch-0001.elements.parquet",
        element_shard(
            [element("doc-a", 0, "paragraph", 1), element("doc-a", 1, "paragraph", 2)]
        ),
    )

    shape = read_shape(storage, "corpus-1")

    assert [run.run_id for run in shape.runs] == [
        "run-20260201T000000Z",
        "run-20260101T000000Z",
    ]
    assert asset_named(shape, "run-20260201T000000Z", "elements").rows == 2
    assert asset_named(shape, "run-20260101T000000Z", "elements").rows == 1


def test_a_corpus_scope_carries_no_tallies() -> None:
    """A tally scales with the run; the question it answers is asked of a document."""
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    shape = read_shape(storage, "throsby")

    assert asset_named(shape, "run-throsby-demo", "elements").values == {}


# ── document scope ───────────────────────────────────────────────────────────


def test_a_document_is_counted_apart_from_its_neighbours_in_the_same_shard() -> None:
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard(
            [
                element("doc-a", 0, "paragraph", 1),
                element("doc-b", 0, "paragraph", 1),
                element("doc-b", 1, "heading", 1),
            ]
        ),
    )

    shape = read_shape(
        storage, "corpus-1", run_id="run-20260101T000000Z", document_id="doc-b"
    )

    assert asset_named(shape, "run-20260101T000000Z", "elements").rows == 2
    assert shape.documents == 1


def test_a_document_tallies_its_element_kinds() -> None:
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard(
            [
                element("doc-a", 0, "paragraph", 1),
                element("doc-a", 1, "paragraph", 1),
                element("doc-a", 2, "heading", 2),
            ]
        ),
    )

    elements = asset_named(
        read_shape(
            storage, "corpus-1", run_id="run-20260101T000000Z", document_id="doc-a"
        ),
        "run-20260101T000000Z",
        "elements",
    )

    assert elements.values["kind"].counts == [("paragraph", 2), ("heading", 1)]
    assert elements.values["kind"].distinct == 2
    assert elements.values["kind"].truncated is False


def test_a_document_reports_its_printed_page_range() -> None:
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard(
            [
                element("doc-a", 0, "paragraph", 3),
                element("doc-a", 1, "paragraph", 7),
                element("doc-a", 2, "paragraph", 5),
            ]
        ),
    )

    elements = asset_named(
        read_shape(
            storage, "corpus-1", run_id="run-20260101T000000Z", document_id="doc-a"
        ),
        "run-20260101T000000Z",
        "elements",
    )

    assert elements.ranges["page"] == (3, 7)


def test_a_document_scope_never_requests_a_body_column(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The tallied columns are closed-vocabulary labels; text is never projected."""
    storage = FakeObjectStorage()
    load_fixture_run(storage)
    spy = ReadTableSpy(monkeypatch)

    read_shape(
        storage,
        "throsby",
        run_id="run-throsby-demo",
        document_id="c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54",
    )

    assert spy.calls, "a document scope must read the identity column at least once"
    for requested in spy.calls:
        assert requested is not None, "every read must project, never decode whole rows"
        assert not BODY_COLUMNS.intersection(requested)


def test_entity_names_are_not_tallied() -> None:
    """An entity name is unbounded and it is content — `entity_label` is neither."""
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    entities = asset_named(
        read_shape(
            storage,
            "throsby",
            run_id="run-throsby-demo",
            document_id="c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54",
        ),
        "run-throsby-demo",
        "entities",
    )

    assert "name" not in entities.values
    assert "entity_label" in entities.values


def test_a_tally_wider_than_the_cap_says_what_it_withheld() -> None:
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard(
            [
                element("doc-a", order, f"kind-{order:03d}", 1)
                for order in range(MAX_TALLY_VALUES + 10)
            ]
        ),
    )

    kinds = asset_named(
        read_shape(
            storage, "corpus-1", run_id="run-20260101T000000Z", document_id="doc-a"
        ),
        "run-20260101T000000Z",
        "elements",
    ).values["kind"]

    assert len(kinds.counts) == MAX_TALLY_VALUES
    assert kinds.distinct == MAX_TALLY_VALUES + 10
    assert kinds.truncated is True


# ── the real corpus ──────────────────────────────────────────────────────────


def test_the_real_run_reports_womblexs_own_row_counts() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    shape = read_shape(storage, "throsby", run_id="run-throsby-demo")

    assert asset_named(shape, "run-throsby-demo", "elements").rows == 24
    assert asset_named(shape, "run-throsby-demo", "chunks").rows == 4
    assert asset_named(shape, "run-throsby-demo", "form_fields").rows == 2
    assert asset_named(shape, "run-throsby-demo", "graph_edges").rows == 156
    assert asset_named(shape, "run-throsby-demo", "entities").rows == 34
    assert asset_named(shape, "run-throsby-demo", "money_spans").rows == 2


def test_the_real_run_reports_columns_for_an_empty_asset() -> None:
    """`table_cells` is present and empty — a client must tell that from absent."""
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    table_cells = asset_named(
        read_shape(storage, "throsby", run_id="run-throsby-demo"),
        "run-throsby-demo",
        "table_cells",
    )

    assert table_cells.present is True
    assert table_cells.rows == 0
    assert [column.name for column in table_cells.columns][:2] == [
        "source_hash",
        "parent_elem_order",
    ]


def test_the_real_document_tallies_the_kinds_it_actually_holds() -> None:
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    elements = asset_named(
        read_shape(
            storage,
            "throsby",
            run_id="run-throsby-demo",
            document_id="c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54",
        ),
        "run-throsby-demo",
        "elements",
    )

    assert dict(elements.values["kind"].counts)["paragraph"] == 15
    assert dict(elements.values["kind"].counts)["heading"] == 2
    assert elements.ranges["page"] == (0, 2)


# ── the HTTP seam ────────────────────────────────────────────────────────────


def test_the_shape_route_serves_one_runs_counts(
    client, storage: FakeObjectStorage
) -> None:
    load_fixture_run(storage)

    body = client.get("/runs/throsby/run-throsby-demo/shape").json()

    elements = next(
        asset for asset in body["runs"][0]["assets"] if asset["name"] == "elements"
    )
    assert body["runId"] == "run-throsby-demo"
    assert elements["rows"] == 24


def test_the_shape_route_narrows_to_one_document(
    client, storage: FakeObjectStorage
) -> None:
    load_fixture_run(storage)

    body = client.get(
        "/runs/throsby/run-throsby-demo/shape",
        params={
            "documentId": "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54"
        },
    ).json()

    elements = next(
        asset for asset in body["runs"][0]["assets"] if asset["name"] == "elements"
    )
    assert body["documents"] == 1
    assert {entry["value"]: entry["rows"] for entry in elements["values"]["kind"]["counts"]}[
        "paragraph"
    ] == 15
    assert elements["ranges"]["page"] == {"min": 0, "max": 2}


def test_the_corpus_shape_route_keeps_runs_apart(
    client, storage: FakeObjectStorage
) -> None:
    load_fixture_run(storage, run_id="run-20260101T000000Z")
    load_fixture_run(storage, run_id="run-20260201T000000Z")

    body = client.get("/runs/throsby/shape").json()

    assert [run["runId"] for run in body["runs"]] == [
        "run-20260201T000000Z",
        "run-20260101T000000Z",
    ]
    # One document, staged twice. A corpus-scope total would have to say whether
    # those are the same document, which needs every run's identity column read.
    assert body["documents"] is None
    assert [run["documents"] for run in body["runs"]] == [1, 1]
    assert all(
        next(asset for asset in run["assets"] if asset["name"] == "elements")["rows"]
        == 24
        for run in body["runs"]
    )


def test_a_corpus_scope_carries_no_column_schemas() -> None:
    """Twelve assets' column lists are ~20KB answering a question this scope is
    not asking. The run scope, one call away, is where a schema is wanted."""
    storage = FakeObjectStorage()
    load_fixture_run(storage)

    corpus = asset_named(read_shape(storage, "throsby"), "run-throsby-demo", "elements")
    run = asset_named(
        read_shape(storage, "throsby", run_id="run-throsby-demo"),
        "run-throsby-demo",
        "elements",
    )

    assert corpus.columns == []
    assert corpus.rows == 24
    assert [column.name for column in run.columns][:2] == ["source_hash", "collection_id"]


# ── what sizing is allowed to cost ───────────────────────────────────────────


class TailOnlyStorage(FakeObjectStorage):
    """Refuses a whole-object read, and records what was fetched instead.

    Sizing that decodes nothing but still transfers everything is the failure this
    guards: it passes a `read_table` spy while gigabytes cross the wire.
    """

    def __init__(self) -> None:
        super().__init__()
        self.tail_bytes = 0
        self.listings = 0
        self.whole_reads: List[str] = []

    def get_object(self, key: str) -> bytes:
        self.whole_reads.append(key)
        return super().get_object(key)

    def get_object_tail(self, key: str, length: int) -> bytes:
        tail = super().get_object_tail(key, length)
        self.tail_bytes += len(tail)
        return tail

    def list_objects(self, prefix: str) -> List[str]:
        self.listings += 1
        return super().list_objects(prefix)


def test_sizing_a_run_never_fetches_a_whole_shard() -> None:
    storage = TailOnlyStorage()
    load_fixture_run(storage)
    total = sum(len(body) for body in storage.objects.values())

    read_shape(storage, "throsby", run_id="run-throsby-demo")

    assert storage.whole_reads == []
    assert storage.tail_bytes < total


def test_sizing_a_run_lists_the_corpus_prefix_once() -> None:
    """Selecting per (run, asset) walks the whole prefix twelve times per run."""
    storage = TailOnlyStorage()
    load_fixture_run(storage)

    read_shape(storage, "throsby", run_id="run-throsby-demo")

    assert storage.listings == 1


def test_a_run_without_a_manifest_still_counts_its_documents() -> None:
    """Nought documents beside 3 elements is a contradiction, not an answer."""
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard(
            [
                element("doc-a", 0, "paragraph", 1),
                element("doc-b", 0, "paragraph", 1),
                element("doc-b", 1, "heading", 1),
            ]
        ),
    )

    shape = read_shape(storage, "corpus-1", run_id="run-20260101T000000Z")

    assert asset_named(shape, "run-20260101T000000Z", "elements").rows == 3
    assert shape.runs[0].documents == 2


def test_a_document_is_counted_even_when_columns_are_not_reported() -> None:
    """Column *reporting* is a payload choice; the schema is still needed to find
    the identity column, and tying the two together made every count nought."""
    storage = FakeObjectStorage()
    stage(
        storage,
        "proc/corpus-1/run-20260101T000000Z/documents/batch-0001.elements.parquet",
        element_shard([element("doc-a", 0, "paragraph", 1), element("doc-b", 0, "heading", 1)]),
    )

    shape = read_shape(storage, "corpus-1", document_id="doc-a")

    elements = asset_named(shape, "run-20260101T000000Z", "elements")
    assert elements.rows == 1
    assert elements.columns == []


def test_an_unknown_corpus_is_not_an_empty_one(client) -> None:
    """A typo and an empty corpus lead to opposite next actions."""
    response = client.get("/runs/no-such-corpus/shape")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_an_unknown_run_is_not_an_empty_one(client, storage: FakeObjectStorage) -> None:
    load_fixture_run(storage)

    response = client.get("/runs/throsby/run-does-not-exist/shape")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"
