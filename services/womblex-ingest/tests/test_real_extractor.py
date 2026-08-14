"""Thread 37b — the real binding, driven over real Parquet shards.

This suite proves the binding's own contract *without* invoking the engine: given
the Parquet shard layout womblex lands in MinIO (`proc/{evaluationId}/
*.elements/.chunks/.table_cells/.embeddings.parquet`, keyed by `source_hash`),
`RealWomblexExtractor` reads them from object storage and maps womblex's schema
into the JSON read model — with no re-writing of the durable Parquet (the engine
owns it). We fake only the MinIO seam; the read + decode + map path is exactly
the production one.

Why fake the engine rather than run it: not an interpreter constraint (the
sidecar image is `python:3.12-slim`, which is inside womblex's own 3.11/3.12
support — see ADR-0003), but a test-shape one. The engine is a heavy, separately
scaled subsystem that produces shards via its own cloud runner; the *binding's*
contract is the read + map, and that is provable from real Parquet bytes alone.
The default `validate.sh` box does not install the engine (and may run a newer
interpreter than the engine supports), so `test_..._matches_the_engines` below
`importorskip`s it while everything here runs on pyarrow alone.

These write *real* Parquet (via pyarrow, the same decoder the binding uses) into
an in-memory `FakeObjectStorage`, so the read + decode + map path is the
production code path with only the MinIO seam faked — the same posture Thread 19
took for the embeddings seam.

pyarrow is in the `[dev]` extra, so this suite **runs in the default validate
lane**. It used to be reachable only where the engine was installed, which meant
every test here skipped under `validate.sh` — a mapping written against columns
womblex never writes reported green for as long as that held.

The engine-produced-shards proof (real corpus → real engine → these same reads)
is the compose-level smoke owed to a runtime with Podman, and remains V5
.
"""

from __future__ import annotations

import io
import math
from typing import List, Mapping, Optional

import pytest

pa = pytest.importorskip("pyarrow")
pq = pytest.importorskip("pyarrow.parquet")

from tests.conftest import FakeObjectStorage  # noqa: E402
from womblex_ingest.real_extractor import RealWomblexExtractor  # noqa: E402
from womblex_ingest.shard_reader import ShardSchemaError  # noqa: E402

SOURCE_HASH = "82f9355eabcd0001"
OTHER_HASH = "aaaa000011112222"
MODEL = "kanon-2-embedder"


# womblex's `TABLE_CELLS_SCHEMA`, mirrored exactly from `services/womblex` @
# `v0.2.0` (`src/womblex/store/output.py:82`). Mirrored rather than imported
# because the default validate box does not install the engine;
# `test_the_mirrored_table_cells_schema_matches_the_engines` asserts the mirror
# against the real object whenever womblex IS importable, so the two cannot drift
# in silence. That guard is the point: the previous fixtures here invented
# `elem_order` / `col_index` / `is_currency`, so the suite stayed green while the
# mapping raised on every row a real shard contains.
TABLE_CELLS_SCHEMA = pa.schema(
    [
        ("source_hash", pa.string()),
        ("parent_elem_order", pa.int32()),
        ("row", pa.int32()),
        ("col", pa.int32()),
        ("value", pa.string()),
        ("rowspan", pa.int32()),
        ("colspan", pa.int32()),
        ("value_type", pa.string()),
    ]
)


def _parquet(
    rows: List[Mapping[str, object]],
    metadata: Optional[dict] = None,
    schema: Optional["pa.Schema"] = None,
) -> bytes:
    table = pa.Table.from_pylist(rows, schema=schema)
    if metadata:
        merged = {**(table.schema.metadata or {}), **metadata}
        table = table.replace_schema_metadata(merged)
    buffer = io.BytesIO()
    pq.write_table(table, buffer)
    return buffer.getvalue()


def _table_cell(row: int, col: int, value: str) -> dict:
    """One `table_cells` row with every column womblex writes, real spellings."""
    return {
        "source_hash": SOURCE_HASH,
        "parent_elem_order": 2,
        "row": row,
        "col": col,
        "value": value,
        "rowspan": 1,
        "colspan": 1,
        # Always "text" at v0.2.0 — currency is derived from the value (ADR-0016).
        "value_type": "text",
    }


def _put(
    storage: FakeObjectStorage,
    evaluation_id: str,
    name: str,
    body: bytes,
    *,
    run_id: Optional[str] = None,
) -> None:
    """Land one shard for an evaluation, optionally under a run's own directory.

    With `run_id`, the key mirrors what the engine writes —
    `proc/{evaluationId}/runs/<run_id>/documents/<name>` — so run selection is
    tested against the real layout. Without one, the flat legacy layout the
    earliest fixtures use, which the extractor still reads as a single run.
    """
    prefix = f"proc/{evaluation_id}/"
    if run_id is not None:
        prefix += f"runs/{run_id}/documents/"
    storage.put_object(f"{prefix}{name}", body, "application/octet-stream")


def _put_document_shards(
    storage: FakeObjectStorage,
    *,
    source_hash: str = SOURCE_HASH,
    with_embeddings: bool = True,
    run_id: Optional[str] = None,
) -> None:
    """Land one document's element/chunk/cell (and optional embedding) shards."""
    _put(
        storage,
        "eval-real",
        "batch-0000.elements.parquet",
        _parquet(
            [
                {"source_hash": source_hash, "elem_order": 0, "page": 1, "kind": "heading", "text": "Heading", "alt_text": None},
                {"source_hash": source_hash, "elem_order": 1, "page": 1, "kind": "paragraph", "text": "network security controls", "alt_text": None},
                # Thread 61: non-text kinds serialise `text: None`. The `table`
                # element is the parent of the `table_cells` below, so if its null
                # text raised, the document — and all of its pricing — would be
                # lost. The `image` carries only `alt_text`.
                {"source_hash": source_hash, "elem_order": 2, "page": 1, "kind": "table", "text": None, "alt_text": None},
                {"source_hash": source_hash, "elem_order": 3, "page": 1, "kind": "image", "text": None, "alt_text": "Vendor logo"},
            ]
        ),
        run_id=run_id,
    )
    _put(
        storage,
        "eval-real",
        "batch-0000.chunks.parquet",
        _parquet(
            [
                {
                    "source_hash": source_hash,
                    "chunk_index": 1,
                    "text": "network security controls",
                    "content_type": "narrative",
                },
                {
                    "source_hash": source_hash,
                    "chunk_index": 0,
                    "text": "heading",
                    "content_type": "narrative",
                },
            ]
        ),
        run_id=run_id,
    )
    _put(
        storage,
        "eval-real",
        "batch-0000.table_cells.parquet",
        _parquet(
            [
                _table_cell(row=0, col=1, value="$80,000.00"),
                # An unmarked number in the next column: a quantity, a weighting or
                # an unlabelled price — indistinguishable, so not currency.
                _table_cell(row=0, col=2, value="80000"),
            ],
            schema=TABLE_CELLS_SCHEMA,
        ),
        run_id=run_id,
    )
    if with_embeddings:
        _put(
            storage,
            "eval-real",
            "batch-0000.embeddings.parquet",
            _parquet(
                [
                    {
                        "source_hash": source_hash,
                        "chunk_index": 0,
                        "content_type": "narrative",
                        "model": MODEL,
                        "task": "retrieval/document",
                        "dim": 3,
                        "vector": [0.9, 0.1, 0.0],
                    },
                    {
                        "source_hash": source_hash,
                        "chunk_index": 1,
                        "content_type": "narrative",
                        "model": MODEL,
                        "task": "retrieval/document",
                        "dim": 3,
                        "vector": [0.0, 0.1, 0.9],
                    },
                ]
            ),
            run_id=run_id,
        )


def _corpus_storage(*, with_embeddings: bool = True) -> FakeObjectStorage:
    """A pod-produced shard set for one evaluation, batched womblex-style."""
    storage = FakeObjectStorage()
    _put_document_shards(storage, with_embeddings=with_embeddings)
    return storage


def test_reads_the_pod_shards_into_a_json_read_model() -> None:
    storage = _corpus_storage()

    result = RealWomblexExtractor(storage, "redline").extract("eval-real", ["SynthResponse1.pdf"])

    assert result.document_count == 1
    # The engine owns the durable Parquet; the binding does not re-write shards.
    assert result.shards == []
    document = result.documents[0]
    assert document.documentId == SOURCE_HASH
    # Thread 61: every element maps, including the non-text `table` and `image`
    # kinds. `table` (null text) → ""; `image` → its `alt_text`. elementOrder
    # stays contiguous, which the table-cell join below relies on.
    assert [(e.elementOrder, e.text) for e in document.elements] == [
        (0, "Heading"),
        (1, "network security controls"),
        (2, ""),
        (3, "Vendor logo"),
    ]
    # Chunks come back ordered by chunk_index, with the recomposed join key.
    assert [c.chunkId for c in document.chunks] == [f"{SOURCE_HASH}:0", f"{SOURCE_HASH}:1"]
    # Thread 56's exit test, on a shard carrying womblex's real column names:
    # `parent_elem_order` maps, `col` maps, and the marked cell flags as currency
    # while the bare number beside it does not (ADR-0016).
    assert [(c.columnIndex, c.rawValue, c.isCurrency) for c in document.tableCells] == [
        (1, "$80,000.00", True),
        (2, "80000", False),
    ]
    assert document.tableCells[0].elementOrder == 2


def test_embeddings_declare_womblexs_real_model_not_the_stub() -> None:
    storage = _corpus_storage()

    result = RealWomblexExtractor(storage, "redline").extract("eval-real", ["x.pdf"])

    embeddings = result.embeddings[0]
    assert embeddings.documentId == SOURCE_HASH
    assert embeddings.model == MODEL
    assert embeddings.model != "stub-deterministic-v1"
    # Joinable on (source_hash, chunk_index); L2-normalised across the boundary.
    assert [(v.chunkId, v.chunkIndex) for v in embeddings.vectors] == [
        (f"{SOURCE_HASH}:0", 0),
        (f"{SOURCE_HASH}:1", 1),
    ]
    for vector in embeddings.vectors:
        assert math.isclose(math.sqrt(sum(x * x for x in vector.values)), 1.0, rel_tol=1e-9)


def test_absent_embed_stage_omits_embeddings_but_still_extracts() -> None:
    storage = _corpus_storage(with_embeddings=False)

    result = RealWomblexExtractor(storage, "redline").extract("eval-real", ["x.pdf"])

    assert result.document_count == 1
    # Extraction still serves; the embeddings resource is simply absent (NOT_FOUND
    # upstream), never an empty payload.
    assert result.embeddings == []


def test_no_shards_under_the_prefix_fails_loudly() -> None:
    # An empty ExtractionResult would masquerade as "extracted, found nothing";
    # the binding refuses so a missing engine run is diagnosable.
    with pytest.raises(ShardSchemaError):
        RealWomblexExtractor(FakeObjectStorage(), "redline").extract("eval-real", ["x.pdf"])


def test_retrieval_sorts_a_query_onto_its_nearest_chunk() -> None:
    """The semantic property the stub could not give: a real query vector matched
    against the real chunk vectors ranks the on-topic chunk first.

    Thread 22's `ClassifyByRetrieval` is TypeScript and re-runs unchanged against
    this payload; here we assert the vectors are *matchable* — a dot product over
    the L2-normalised chunk vectors puts the security chunk (index 1) ahead of the
    heading chunk (index 0) for a security-shaped query, which is exactly the
    ranking the stub's hand-chosen vectors could only fake.
    """
    storage = _corpus_storage()
    result = RealWomblexExtractor(storage, "redline").extract("eval-real", ["x.pdf"])
    vectors = {v.chunkIndex: v.values for v in result.embeddings[0].vectors}

    # A normalised query pointing at the "security" axis (the third component).
    query = [0.0, 0.1, 0.9]
    magnitude = math.sqrt(sum(x * x for x in query))
    query = [x / magnitude for x in query]

    def cosine(chunk_index: int) -> float:
        return sum(q * c for q, c in zip(query, vectors[chunk_index]))

    assert cosine(1) > cosine(0)


def test_defaults_to_the_latest_run_when_more_than_one_is_present() -> None:
    """Two runs under the same evaluation prefix must not merge into one document.

    The store held exactly one run's worth of rows only by accident — the oldest
    run predated the chunk stage and carried no shards. Once two real runs are
    present, globbing the whole prefix double-counts every `source_hash`:
    `elementOrder` repeats and the chunk store doubles. Run selection reads one
    run, defaulting to the latest, so the extraction returns 7 elements with
    `elementOrder` 0-6 once each.
    """
    storage = FakeObjectStorage()
    _put_document_shards(storage, run_id="run-20260101T000000Z")
    _put_document_shards(storage, run_id="run-20260806T000000Z")

    result = RealWomblexExtractor(storage, "redline").extract("eval-real", ["x.pdf"])

    assert result.document_count == 1
    document = result.documents[0]
    assert [e.elementOrder for e in document.elements] == [0, 1, 2, 3]


def test_an_explicit_run_id_selects_that_run_not_the_latest() -> None:
    storage = FakeObjectStorage()
    _put_document_shards(storage, source_hash=SOURCE_HASH, run_id="run-20260101T000000Z")
    _put_document_shards(storage, source_hash=OTHER_HASH, run_id="run-20260806T000000Z")

    result = RealWomblexExtractor(storage, "redline").extract(
        "eval-real", ["x.pdf"], run_id="run-20260101T000000Z"
    )

    assert result.document_count == 1
    assert result.documents[0].documentId == SOURCE_HASH


def test_an_absent_explicit_run_id_fails_loudly() -> None:
    # A typo'd run id must not read as "extracted, found nothing".
    storage = FakeObjectStorage()
    _put_document_shards(storage, run_id="run-20260806T000000Z")

    with pytest.raises(ShardSchemaError):
        RealWomblexExtractor(storage, "redline").extract(
            "eval-real", ["x.pdf"], run_id="run-does-not-exist"
        )


def test_the_embed_stage_model_falls_back_to_shard_metadata() -> None:
    # womblex records the model as a column; a producer that records it only in
    # the file's key/value metadata is still readable, so vectors are not refused
    # for want of a declaration that is present in the other place.
    storage = _corpus_storage(with_embeddings=False)
    _put(
        storage,
        "eval-real",
        "batch-0000.embeddings.parquet",
        _parquet(
            [{"source_hash": SOURCE_HASH, "chunk_index": 0, "vector": [1.0, 0.0]}],
            metadata={b"model": MODEL.encode()},
        ),
    )

    result = RealWomblexExtractor(storage, "redline").extract("eval-real", ["x.pdf"])

    assert result.embeddings[0].model == MODEL


def test_the_mirrored_table_cells_schema_matches_the_engines() -> None:
    """redline's assumed `table_cells` schema is womblex's actual one.

    The guard that would have caught this thread's defect at the source. It runs
    only where the engine is installed — but where it runs, a submodule bump that
    changes the shard schema fails here rather than three layers downstream as an
    empty pricing column. This is the only thing that catches such a bump, which
    is why it asserts against the real object rather than a second mirror.
    """
    output = pytest.importorskip("womblex.store.output")

    assert TABLE_CELLS_SCHEMA.equals(output.TABLE_CELLS_SCHEMA)
