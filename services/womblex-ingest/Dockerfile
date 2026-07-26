# womblex-ingest — the lightweight FastAPI read seam (Parquet→JSON) for redline.
#
# This image stays LIGHT. The real womblex engine is a REQUIRED subsystem of
# redline but lives in its OWN pod (Dockerfile.womblex / the `womblex` compose
# service, Thread 37a) because its OCR/tokeniser/model runtime is heavy and its
# resource profile is disparate from this API sidecar's. This image never
# installs womblex; it reads the shards the womblex pod wrote and serves them as
# JSON (ADR-0003).
#
# WOMBLEX_MODE selects the extractor at runtime:
#   - real (redline's deployment): the real extractor reads the womblex pod's
#     shards from MinIO.
#   - stub (the dependency-free TEST DOUBLE): deterministic shards for fast CI and
#     the Thread 4 adapter contract. NOT a shipping mode — a test double.
FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir .

ENV S3_ENDPOINT=http://minio:9000 \
    S3_ACCESS_KEY=minioadmin \
    S3_SECRET_KEY=minioadmin \
    REDLINE_BUCKET=redline \
    WOMBLEX_MODE=stub \
    HOST=0.0.0.0 \
    PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health',timeout=4).status==200 else 1)"]

CMD ["uvicorn", "womblex_ingest.asgi:app", "--host", "0.0.0.0", "--port", "8000"]
