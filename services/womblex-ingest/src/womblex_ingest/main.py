"""FastAPI surface for the womblex-ingest sidecar.

The read seam redline serves everything through:

- `GET /runs/{corpus_id}` — the corpus's runs, newest first
- `GET /runs/{corpus_id}/{run_id}/assets` — which shard families the run holds
- `GET /runs/{corpus_id}/{run_id}/shards/{asset}` — one run's rows for one shard
  family, with the schema they conform to, in womblex's own column names
- `GET /runs/{corpus_id}/shape` — every run's size, from Parquet footers alone
- `GET /runs/{corpus_id}/{run_id}/shape` — one run's size, or one document's
  size and shape within it (`?documentId=`)

Plus the ingest lifecycle (`POST /ingest`, `GET /status/{run_id}`), the earlier
per-document read model (`GET /extractions/{evaluation_id}/{document_id}`) and
`GET /health`.

Errors cross the HTTP boundary as a Result-shaped body
`{"error": {"code", "message"}}`, mirroring redline's domain Result pattern so
the adapter maps them into `DomainError` cleanly.
"""

from __future__ import annotations

import json
from typing import List, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from womblex_ingest.extraction import Extractor
from womblex_ingest.runs import Run, RunRegistry
from womblex_ingest.shape import read_shape
from womblex_ingest.shards import (
    ASSETS,
    DEFAULT_LIMIT,
    AssetNotReadable,
    UnknownAsset,
    list_runs,
    read_shard,
    run_id_for_key,
)
from womblex_ingest.storage import ObjectNotFound, ObjectStorage


def extraction_key(evaluation_id: str, document_id: str) -> str:
    """Object key for a document's JSON read model, beside its Parquet shards."""
    return f"proc/{evaluation_id}/{document_id}.extraction.json"


class IngestRequest(BaseModel):
    evaluationId: str
    documentNames: List[str]
    # Optional: which womblex run to read. Omitted reads the latest run under the
    # evaluation's prefix, so every existing caller keeps working; an explicit id
    # pins a specific run (the real extractor selects it — the stub ignores it).
    runId: Optional[str] = None


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


def build_app(
    *,
    storage: ObjectStorage,
    extractor: Extractor,
    bucket: str,
    womblex_mode: str = "stub",
    isaacus_enabled: bool = False,
) -> FastAPI:
    app = FastAPI(title="womblex-ingest", version="0.1.0")
    registry = RunRegistry()

    @app.get("/health")
    def health() -> dict:
        # Surfaces the live extraction path and whether Isaacus is reachable.
        # On the real lane `isaacusEnabled: false` means retrieval cannot run —
        # a misconfiguration to surface, not a supported offline mode.
        return {
            "status": "ok",
            "bucket": bucket,
            "womblexMode": womblex_mode,
            "isaacusEnabled": isaacus_enabled,
        }

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
            result = extractor.extract(
                evaluation_id, request.documentNames, request.runId
            )
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

    @app.get("/runs/{corpus_id}")
    def corpus_runs(corpus_id: str) -> JSONResponse:
        """Every womblex run under the corpus prefix, newest first."""
        runs = list_runs(storage, corpus_id)
        if not runs:
            return _error(
                404,
                "NOT_FOUND",
                f"no womblex shards under proc/{corpus_id}/ — has the engine run "
                "for this corpus?",
            )
        return JSONResponse(
            status_code=200,
            content={
                "corpusId": corpus_id,
                "runs": [
                    {
                        "runId": run.run_id,
                        "versioned": run.versioned,
                        "shardCount": run.shard_count,
                    }
                    for run in runs
                ],
            },
        )

    @app.get("/runs/{corpus_id}/shape")
    def corpus_shape(corpus_id: str) -> JSONResponse:
        """Every run under the corpus, with per-asset row counts.

        Deliberately takes no `documentId`: a document is sized within the run
        that produced it, and a cross-run document read is a question about
        provenance rather than about size.
        """
        shape = read_shape(storage, corpus_id)
        if not shape.runs:
            return _error(
                404,
                "NOT_FOUND",
                f"no womblex shards under proc/{corpus_id}/ — has the engine run "
                "for this corpus?",
            )
        return JSONResponse(status_code=200, content=shape.to_json())

    @app.get("/runs/{corpus_id}/{run_id}/shape")
    def run_shape(
        corpus_id: str, run_id: str, documentId: Optional[str] = None
    ) -> JSONResponse:
        """One run's size — narrowed to one document, its shape as well."""
        shape = read_shape(storage, corpus_id, run_id=run_id, document_id=documentId)
        # An empty answer and a mistyped id are indistinguishable to a caller, and
        # they lead to opposite next actions: retry narrower, or fix the id. The
        # sibling `/runs/{corpus_id}` route already draws this line.
        if not shape.runs:
            return _error(
                404,
                "NOT_FOUND",
                f"no run {run_id!r} under proc/{corpus_id}/",
            )
        return JSONResponse(status_code=200, content=shape.to_json())

    @app.get("/runs/{corpus_id}/{run_id}/assets")
    def run_assets(corpus_id: str, run_id: str) -> JSONResponse:
        """The shard families this run holds, and which of them redline serves."""
        keys = [
            key
            for key in storage.list_objects(f"proc/{corpus_id}/")
            if run_id_for_key(key) == run_id
        ]
        return JSONResponse(
            status_code=200,
            content={
                "corpusId": corpus_id,
                "runId": run_id,
                "assets": [
                    {
                        "name": asset.name,
                        "readable": asset.readable,
                        "present": any(key.endswith(asset.suffix) for key in keys),
                        "identityColumns": list(asset.identity_columns),
                    }
                    for asset in ASSETS.values()
                ],
            },
        )

    @app.get("/runs/{corpus_id}/{run_id}/shards/{asset}")
    def run_shard(
        corpus_id: str,
        run_id: str,
        asset: str,
        documentId: Optional[str] = None,
        limit: int = DEFAULT_LIMIT,
        offset: int = 0,
    ) -> JSONResponse:
        """One run's rows for one shard family, verbatim, with their schema."""
        try:
            page = read_shard(
                storage,
                corpus_id,
                run_id,
                asset,
                document_id=documentId,
                limit=limit,
                offset=offset,
            )
        except UnknownAsset as unknown:
            return _error(404, "NOT_FOUND", str(unknown))
        except AssetNotReadable as refused:
            return _error(422, "ASSET_NOT_READABLE", str(refused))
        return JSONResponse(status_code=200, content=page.to_json())

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
    extractor = build_extractor(settings.womblex_mode, storage=storage, bucket=settings.bucket)

    return build_app(
        storage=storage,
        extractor=extractor,
        bucket=settings.bucket,
        womblex_mode=settings.womblex_mode,
        isaacus_enabled=settings.isaacus_enabled,
    )
