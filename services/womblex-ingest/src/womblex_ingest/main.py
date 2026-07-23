"""FastAPI surface for the womblex-ingest sidecar.

Routes: `POST /ingest` (run extraction, write shards + JSON, return a run id),
`GET /status/{run_id}`, and `GET /extractions/{evaluation_id}/{document_id}` — the
Parquet→JSON read seam the Thread 4 adapter consumes. Errors cross the HTTP
boundary as a Result-shaped body `{"error": {"code", "message"}}`, mirroring
redline's domain Result pattern so the adapter maps them into `DomainError` cleanly.
"""

from __future__ import annotations

import json
from typing import List, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from womblex_ingest.extraction import Extractor
from womblex_ingest.runs import Run, RunRegistry
from womblex_ingest.storage import ObjectNotFound, ObjectStorage


def extraction_key(evaluation_id: str, document_id: str) -> str:
    """Object key for a document's JSON read model, beside its Parquet shards."""
    return f"proc/{evaluation_id}/{document_id}.extraction.json"


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

        # The JSON read model lives beside the Parquet shards (the Parquet→JSON
        # boundary). Storing it in MinIO keeps the read seam durable across a
        # sidecar restart — the in-memory run registry is not the record.
        for document in result.documents:
            storage.put_object(
                extraction_key(evaluation_id, document.documentId),
                json.dumps(document.to_json()).encode("utf-8"),
                "application/json",
            )

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

    @app.get("/extractions/{evaluation_id}/{document_id}")
    def read_extraction(evaluation_id: str, document_id: str) -> JSONResponse:
        """Serve one document's JSON read model — the Parquet→JSON seam.

        The TS adapter (`IProcurementExtractionReader`) reads elements / chunks /
        table cells from this single document-scoped payload.
        """
        try:
            body = storage.get_object(extraction_key(evaluation_id, document_id))
        except ObjectNotFound:
            return _error(
                404,
                "NOT_FOUND",
                f"no extraction for document {document_id} in evaluation {evaluation_id}",
            )
        return JSONResponse(status_code=200, content=json.loads(body))

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
