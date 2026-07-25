"""Air-gap validation (Thread 15).

The exit criterion for Thread 15 is: **the full pipeline runs with `ISAACUS_API_KEY`
unset**. These tests build the app the way the process does at startup
(`build_app_from_env`) with the Isaacus key removed from the environment and the
S3 seam faked, then drive the whole ingest → shards → JSON read seam and assert it
completes end to end with the enrichment path reporting `offline`. No Isaacus, no
network — this is the air-gapped default.

The live compose-level proof (a real MinIO, real HTTP) is `scripts/thread-15-airgap.sh`;
here we prove the same wiring offline so the exit criterion gates in CI without a
container runtime.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import womblex_ingest.main as main
from womblex_ingest.config import Settings
from womblex_ingest.extraction import build_extractor
from tests.conftest import FakeObjectStorage


@pytest.fixture()
def airgapped_client(
    monkeypatch: pytest.MonkeyPatch, storage: FakeObjectStorage
) -> TestClient:
    """The app built from env with `ISAACUS_API_KEY` unset, S3 faked in place.

    Mirrors `build_app_from_env` but swaps the boto3 S3 writer for the in-memory
    fake so no MinIO is needed; everything else is the real startup path.
    """
    monkeypatch.delenv("ISAACUS_API_KEY", raising=False)
    monkeypatch.delenv("WOMBLEX_MODE", raising=False)

    settings = Settings.from_env()
    assert settings.enrichment_mode.value == "offline"

    extractor = build_extractor(settings.womblex_mode)
    return TestClient(
        main.build_app(
            storage=storage,
            extractor=extractor,
            bucket=settings.bucket,
            womblex_mode=settings.womblex_mode,
            enrichment_mode=settings.enrichment_mode.value,
        )
    )


def test_health_reports_offline_with_no_isaacus_key(airgapped_client: TestClient) -> None:
    body = airgapped_client.get("/health").json()

    assert body["status"] == "ok"
    assert body["enrichmentMode"] == "offline"
    assert body["isaacusEnabled"] is False


def test_full_pipeline_runs_air_gapped(
    airgapped_client: TestClient, storage: FakeObjectStorage
) -> None:
    # Ingest → shards land → the JSON read seam serves the document, all with
    # ISAACUS_API_KEY unset. This is the Thread 15 exit criterion.
    ingest = airgapped_client.post(
        "/ingest",
        json={"evaluationId": "airgap-1", "documentNames": ["tender.pdf"]},
    )
    assert ingest.status_code == 202
    assert ingest.json()["status"] == "succeeded"

    shards = storage.keys_under("proc/airgap-1/")
    assert "proc/airgap-1/_manifest.parquet" in shards

    # The stub extractor keys documents by a womblex-style source_hash, so
    # discover the served documentId from the JSON read model beside the shards
    # rather than assuming the raw filename.
    extraction_keys = [key for key in shards if key.endswith(".extraction.json")]
    assert len(extraction_keys) == 1
    document_id = extraction_keys[0].removeprefix("proc/airgap-1/").removesuffix(
        ".extraction.json"
    )

    extraction = airgapped_client.get(f"/extractions/airgap-1/{document_id}")
    assert extraction.status_code == 200
    body = extraction.json()
    assert body["documentId"] == document_id
    assert body["elements"]
    assert body["chunks"][0]["chunkId"] == f"{document_id}:0"
