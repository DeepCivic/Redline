"""HTTP surface + run-lifecycle tests for the womblex-ingest sidecar."""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import FakeObjectStorage, StubExtractor


def test_health_reports_ok(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


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

    assert storage.keys_under("proc/eval-a/") == [
        "proc/eval-a/_manifest.parquet",
        "proc/eval-a/x.pdf.elements.parquet",
    ]
    assert storage.keys_under("proc/eval-b/") == [
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


def test_ingest_marks_run_failed_when_extraction_raises(
    storage: FakeObjectStorage,
) -> None:
    class BrokenExtractor(StubExtractor):
        def extract(self, evaluation_id, document_names):  # type: ignore[override]
            raise RuntimeError("womblex blew up")

    from womblex_ingest.main import build_app

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
