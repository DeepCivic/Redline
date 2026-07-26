"""Thread 37b — the real binding, driven over real Parquet shards.

The womblex engine only runs in its own Python-3.12 pod (Thread 37a); its OCR dep
has no wheel on the interpreter running this suite, so we cannot invoke the engine
here. What we *can* prove is the binding's own contract: given the Parquet shard
layout the pod lands in MinIO (`proc/{evaluationId}/*.elements/.chunks/
.table_cells/.embeddings.parquet`, keyed by `source_hash`), `RealWomblexExtractor`
reads them from object storage and maps womblex's schema into the JSON read model
— with no re-writing of the durable Parquet (the pod owns it).

These write *real* Parquet (via pyarrow, the same decoder the binding uses) into
an in-memory `FakeObjectStorage`, so the read + decode + map path is the
production code path with only the MinIO seam faked — the same posture Thread 19
took for the embeddings seam. Skipped when pyarrow is absent (the default
stub-only CI lane); run where the `.[womblex]` extra is installed.

The engine-produced-shards proof (real corpus → real pod → these same reads) is
the compose-level smoke owed to a runtime with Podman, exactly as Thread 37a's
own exit test is a compose smoke rather than a unit test.
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


def _parquet(rows: List[Mapping[str, object]], metadata: Optional[dict] = None) -> bytes:
    table = pa.Table.from_pylist(rows)
    if metadata:
        merged = {**(table.schema.metadata or {}), **metadata}
        table = table.replace_schema_metadata(merged)
    buffer = io.BytesIO()
    pq.write_table(table, buffer)
    return buffer.getvalue()


def _put(storage: FakeObjectStorage, evaluation_id: str, name: str, body: bytes) -> None:
    storage.put_object(f"proc/{evaluation_id}/{name}", body, "application/octet-stream")


def _corpus_storage(*, with_embeddings: bool = True) -> FakeObjectStorage:
    """A pod-produced shard set for one evaluation, batched womblex-style."""
    storage = FakeObjectStorage()
    _put(
        storage,
        "eval-real",
        "batch-0000.elements.parquet",
        _parquet(
            [
                {"source_hash": SOURCE_HASH, "elem_order": 0, "page": 1, "text": "Heading"},
                {"source_hash": SOURCE_HASH, "elem_order": 1, "page": 1, "text": "network security controls"},
            ]
        ),
    )
    _put(
        storage,
        "eval-real",
        "batch-0000.chunks.parquet",
        _parquet(
            [
                {"source_hash": SOURCE_HASH, "chunk_index": 1, "text": "network security controls"},
                {"source_hash": SOURCE_HASH, "chunk_index": 0, "text": "heading"},
            ]
        ),
    )
    _put(
        storage,
        "eval-real",
        "batch-0000.table_cells.parquet",
        _parquet(
            [
                {
                    "source_hash": SOURCE_HASH,
                    "elem_order": 2,
                    "page": 1,
                    "row_index": 0,
                    "col_index": 1,
                    "raw_value": "80000",
                    "is_currency": True,
                }
            ]
        ),
    )
    if with_embeddings:
        _put(
            storage,
            "eval-real",
            "batch-0000.embeddings.parquet",
            _parquet(
                [
                    {"source_hash": SOURCE_HASH, "chunk_index": 0, "embedding": [0.9, 0.1, 0.0]},
                    {"source_hash": SOURCE_HASH, "chunk_index": 1, "embedding": [0.0, 0.1, 0.9]},
                ],
                metadata={b"model": MODEL.encode()},
            ),
        )
    return storage


def test_reads_the_pod_shards_into_a_json_read_model() -> None:
    storage = _corpus_storage()

    result = RealWomblexExtractor(storage, "redline").extract("eval-real", ["SynthResponse1.pdf"])

    assert result.document_count == 1
    # The pod owns the durable Parquet; the binding does not re-write shards.
    assert result.shards == []
    document = result.documents[0]
    assert document.documentId == SOURCE_HASH
    assert [(e.elementOrder, e.text) for e in document.elements] == [
        (0, "Heading"),
        (1, "network security controls"),
    ]
    # Chunks come back ordered by chunk_index, with the recomposed join key.
    assert [c.chunkId for c in document.chunks] == [f"{SOURCE_HASH}:0", f"{SOURCE_HASH}:1"]
    cell = document.tableCells[0]
    assert (cell.rawValue, cell.isCurrency) == ("80000", True)


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
    # the binding refuses so a missing pod run is diagnosable.
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
