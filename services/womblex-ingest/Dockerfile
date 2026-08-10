# womblex-ingest — the lightweight FastAPI read seam (Parquet→JSON) for redline.
#
# This image stays LIGHT and never installs womblex: it reads the shards the
# engine wrote (from object storage) and serves them as JSON (ADR-0003). The real
# womblex engine is a REQUIRED subsystem of redline; it runs from the engine's OWN
# image (shipped by the submodule, built by the `womblex` compose service). That
# split is a DEPLOYMENT choice for resource/lifecycle isolation, not a hard
# requirement — the engine can equally be co-located with this sidecar (this image
# is python:3.12-slim, inside womblex's 3.11/3.12 support). Keeping this image
# womblex-free is what lets the sidecar stay light either way; the seam is object
# storage, and neither imports the other.
#
# Two build targets:
#   - `sidecar` (default): the light read seam, no womblex. The `womblex-ingest`
#     compose service builds this.
#   - `womblex`: adds the `[womblex]` extra for the money annotation step
#     (item 1), which runs womblex's own `money_shards()`. The `money` compose
#     service builds this.
#
# WOMBLEX_MODE selects the extractor at runtime:
#   - real (redline's deployment): the real extractor reads the engine's shards
#     from object storage.
#   - stub (the dependency-free TEST DOUBLE): deterministic shards for fast CI and
#     the Thread 4 adapter contract. NOT a shipping mode — a test double.
FROM python:3.12-slim AS sidecar

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
