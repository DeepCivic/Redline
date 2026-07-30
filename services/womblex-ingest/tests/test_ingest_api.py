"""HTTP surface + run-lifecycle tests for the womblex-ingest sidecar."""

from __future__ import annotations

from fastapi.testclient import TestClient

from womblex_ingest.chunk_store import InMemoryChunkStore, StructureFilter
from womblex_ingest.main import build_app
from tests.conftest import FakeObjectStorage, StubExtractor


def test_health_reports_ok(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_health_reports_offline_enrichment_by_default(client: TestClient) -> None:
    # The default build (and the air-gapped stub path) reports the offline
    # enrichment mode so a deployment / UI toggle can see Isaacus is not engaged.
    body = client.get("/health").json()

    assert body["womblexMode"] == "stub"
    assert body["isaacusEnabled"] is False


def test_health_reports_isaacus_when_enabled(storage: FakeObjectStorage) -> None:
    client = TestClient(
        build_app(
            storage=storage,
            extractor=StubExtractor(),
            bucket="redline",
            womblex_mode="real",
            isaacus_enabled=True,
        )
    )

    body = client.get("/health").json()

    assert body["womblexMode"] == "real"
    assert body["isaacusEnabled"] is True


def test_ingest_returns_a_run_id(client: TestClient) -> None:
    response = client.post(
        "/ingest",
        json={"evaluationId": "eval-1", "documentNames": ["a.pdf", "b.pdf"]},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["runId"]
    assert body["status"] == "succeeded"
    assert body["documentCount"] == 2


def test_ingest_writes_shards_under_the_evaluation_prefix(
    client: TestClient, storage: FakeObjectStorage
) -> None:
    client.post(
        "/ingest",
        json={"evaluationId": "eval-42", "documentNames": ["tender.pdf"]},
    )

    keys = storage.keys_under("proc/eval-42/")

    assert "proc/eval-42/_manifest.parquet" in keys
    assert "proc/eval-42/tender.pdf.elements.parquet" in keys


def test_ingest_isolates_shards_per_evaluation(
    client: TestClient, storage: FakeObjectStorage
) -> None:
    client.post("/ingest", json={"evaluationId": "eval-a", "documentNames": ["x.pdf"]})
    client.post("/ingest", json={"evaluationId": "eval-b", "documentNames": ["y.pdf"]})

    def shards(prefix: str) -> list[str]:
        return [k for k in storage.keys_under(prefix) if k.endswith(".parquet")]

    assert shards("proc/eval-a/") == [
        "proc/eval-a/_manifest.parquet",
        "proc/eval-a/x.pdf.elements.parquet",
    ]
    assert shards("proc/eval-b/") == [
        "proc/eval-b/_manifest.parquet",
        "proc/eval-b/y.pdf.elements.parquet",
    ]


def test_status_reports_a_finished_run(client: TestClient) -> None:
    run_id = client.post(
        "/ingest",
        json={"evaluationId": "eval-1", "documentNames": ["a.pdf"]},
    ).json()["runId"]

    response = client.get(f"/status/{run_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["runId"] == run_id
    assert body["status"] == "succeeded"
    assert body["evaluationId"] == "eval-1"
    assert sorted(body["shardKeys"]) == [
        "proc/eval-1/_manifest.parquet",
        "proc/eval-1/a.pdf.elements.parquet",
    ]


def test_status_of_unknown_run_is_404(client: TestClient) -> None:
    response = client.get("/status/does-not-exist")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "RUN_NOT_FOUND"


def test_ingest_rejects_empty_evaluation_id(client: TestClient) -> None:
    response = client.post(
        "/ingest",
        json={"evaluationId": "  ", "documentNames": ["a.pdf"]},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_ingest_rejects_empty_document_list(client: TestClient) -> None:
    response = client.post(
        "/ingest",
        json={"evaluationId": "eval-1", "documentNames": []},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_ingest_writes_a_json_read_model_beside_the_shards(
    client: TestClient, storage: FakeObjectStorage
) -> None:
    client.post(
        "/ingest",
        json={"evaluationId": "eval-7", "documentNames": ["tender.pdf"]},
    )

    assert "proc/eval-7/tender.pdf.extraction.json" in storage.objects


def test_read_extraction_serves_the_json_read_model(client: TestClient) -> None:
    client.post(
        "/ingest",
        json={"evaluationId": "eval-9", "documentNames": ["tender.pdf"]},
    )

    response = client.get("/extractions/eval-9/tender.pdf")

    assert response.status_code == 200
    body = response.json()
    assert body["documentId"] == "tender.pdf"
    assert body["elements"][0]["elementOrder"] == 0
    assert body["chunks"][0]["chunkId"] == "tender.pdf:0"
    assert body["tableCells"][0]["isCurrency"] is True


def test_read_extraction_of_unknown_document_is_404(client: TestClient) -> None:
    response = client.get("/extractions/eval-9/missing.pdf")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_ingest_marks_run_failed_when_extraction_raises(
    storage: FakeObjectStorage,
) -> None:
    class BrokenExtractor(StubExtractor):
        def extract(self, evaluation_id, document_names):  # type: ignore[override]
            raise RuntimeError("womblex blew up")

    client = TestClient(
        build_app(storage=storage, extractor=BrokenExtractor(), bucket="redline")
    )

    response = client.post(
        "/ingest",
        json={"evaluationId": "eval-1", "documentNames": ["a.pdf"]},
    )

    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "EXTRACTION_FAILED"
    run_id = body["runId"]

    status = client.get(f"/status/{run_id}").json()
    assert status["status"] == "failed"
    assert storage.keys_under("proc/eval-1/") == []


# ── item 1a: an ingest projects chunks + embeddings into redline's store ────


def test_ingest_lands_chunk_rows_and_embeddings_in_the_store(
    storage: FakeObjectStorage, extractor: StubExtractor
) -> None:
    # The item-1a exit, wired end-to-end: an ingest lands addressable chunk rows
    # (with their embeddings, as available data) in redline's own store alongside
    # the MinIO shards — exact fetch by the stable key returns byte-identical text.
    store = InMemoryChunkStore()
    client = TestClient(
        build_app(storage=storage, extractor=extractor, bucket="redline", chunk_store=store)
    )

    client.post("/ingest", json={"evaluationId": "eval-1", "documentNames": ["tender.pdf"]})

    (row,) = store.fetch_chunks("eval-1", ["tender.pdf:0"])
    assert row.text == "chunk"
    assert row.document_id == "tender.pdf"
    assert row.embedding is not None  # loaded as available data (ADR-0018 addendum)

    by_structure = store.fetch_by_structure("eval-1", StructureFilter(document_id="tender.pdf"))
    assert [r.chunk_id for r in by_structure] == ["tender.pdf:0"]


def test_ingest_without_a_store_still_writes_shards(
    client: TestClient, storage: FakeObjectStorage
) -> None:
    # The stub / air-gapped lane: no store wired, so the ingest serves purely from
    # the shards + JSON seam and does not fail for lack of a database.
    response = client.post(
        "/ingest", json={"evaluationId": "eval-2", "documentNames": ["a.pdf"]}
    )
    assert response.status_code == 202
    assert "proc/eval-2/a.pdf.extraction.json" in storage.objects


def test_ingest_fails_the_run_when_the_store_load_raises(
    storage: FakeObjectStorage, extractor: StubExtractor
) -> None:
    # A store write failure is a failed run, not a silent skip: the store must not
    # drift behind the shards, because projecting into it is the point of the stage.
    class BrokenStore(InMemoryChunkStore):
        def upsert_chunks(self, evaluation_id, rows):  # type: ignore[override]
            raise RuntimeError("redline_ store unreachable")

    client = TestClient(
        build_app(storage=storage, extractor=extractor, bucket="redline", chunk_store=BrokenStore())
    )

    response = client.post(
        "/ingest", json={"evaluationId": "eval-3", "documentNames": ["a.pdf"]}
    )

    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "INFRA_FAILURE"
    status = client.get(f"/status/{body['runId']}").json()
    assert status["status"] == "failed"
