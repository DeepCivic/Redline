"""FastAPI surface for the womblex-ingest sidecar.

Two routes: `POST /ingest` (run extraction, write shards, return a run id) and
`GET /status/{run_id}`. Errors cross the HTTP boundary as a Result-shaped body
`{"error": {"code", "message"}}`, mirroring redline's domain Result pattern so the
Thread 4 adapter maps them into `DomainError` cleanly.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from womblex_ingest.extraction import Extractor
from womblex_ingest.runs import Run, RunRegistry
from womblex_ingest.storage import ObjectStorage


class IngestRequest(BaseModel):
    evaluationId: str
    documentNames: List[str]


def _error(status_code: int, code: str, message: str, run_id: Optional[str] = None) -> JSONResponse:
    body = {"error": {"code": code, "message": message}}
    if run_id is not None:
        body["runId"] = run_id
    return JSONResponse(status_code=status_code, content=body)


def _run_view(run: Run) -> dict:
    return {
        "runId": run.run_id,
        "evaluationId": run.evaluation_id,
        "status": run.status,
        "documentCount": run.document_count,
        "shardKeys": run.shard_keys,
        "error": run.error_message,
    }


def build_app(*, storage: ObjectStorage, extractor: Extractor, bucket: str) -> FastAPI:
    app = FastAPI(title="womblex-ingest", version="0.1.0")
    registry = RunRegistry()

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "bucket": bucket}

    @app.post("/ingest")
    def ingest(request: IngestRequest) -> JSONResponse:
        evaluation_id = request.evaluationId.strip()
        if not evaluation_id:
            return _error(422, "INVALID_REQUEST", "evaluationId must not be empty")
        if not request.documentNames:
            return _error(422, "INVALID_REQUEST", "documentNames must not be empty")

        run = registry.start(evaluation_id)
        prefix = f"proc/{evaluation_id}/"

        try:
            result = extractor.extract(evaluation_id, request.documentNames)
        except Exception as extraction_error:  # womblex failure is a runtime seam error
            registry.mark_failed(run.run_id, str(extraction_error))
            return _error(502, "EXTRACTION_FAILED", str(extraction_error), run_id=run.run_id)

        shard_keys: List[str] = []
        for shard in result.shards:
            key = f"{prefix}{shard.filename}"
            storage.put_object(key, shard.body, shard.content_type)
            shard_keys.append(key)

        registry.mark_succeeded(run.run_id, result.document_count, shard_keys)
        return JSONResponse(
            status_code=202,
            content={
                "runId": run.run_id,
                "status": "succeeded",
                "documentCount": result.document_count,
                "shardKeys": shard_keys,
            },
        )

    @app.get("/status/{run_id}")
    def status(run_id: str) -> JSONResponse:
        run = registry.get(run_id)
        if run is None:
            return _error(404, "RUN_NOT_FOUND", f"no run with id {run_id}")
        return JSONResponse(status_code=200, content=_run_view(run))

    return app


def build_app_from_env() -> FastAPI:
    from womblex_ingest.config import Settings
    from womblex_ingest.extraction import build_extractor
    from womblex_ingest.storage import S3ObjectStorage

    settings = Settings.from_env()
    storage = S3ObjectStorage(
        endpoint_url=settings.s3_endpoint,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        bucket=settings.bucket,
    )
    extractor = build_extractor(settings.womblex_mode)
    return build_app(storage=storage, extractor=extractor, bucket=settings.bucket)
