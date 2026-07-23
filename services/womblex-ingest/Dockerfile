# womblex-ingest — womblex document-extraction sidecar for redline.
#
# Installs the service and its runtime deps. womblex itself is OPT-IN:
#   - default build: stub extractor only (WOMBLEX_MODE=stub), no heavy deps,
#     no Isaacus. Enough for the Thread 3 exit test and air-gapped runs.
#   - --build-arg INSTALL_WOMBLEX=1        installs the real womblex pipeline.
#   - --build-arg ISAACUS=1                additionally enables womblex's Isaacus
#                                          enrichment path (needs ISAACUS_API_KEY
#                                          at runtime). womblex has non-Isaacus
#                                          modes, so this stays off by default.
#
# Mirrors Wayfinder's services/australian-writing-mcp precedent: third-party
# extraction code is installed at build time, never vendored into this repo.
FROM python:3.12-slim

ARG INSTALL_WOMBLEX=0
ARG ISAACUS=0

# git is only needed to resolve a VCS install of womblex when INSTALL_WOMBLEX=1.
RUN apt-get update \
    && apt-get install --no-install-recommends -y git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src

RUN pip install --no-cache-dir . \
    && if [ "$INSTALL_WOMBLEX" = "1" ]; then pip install --no-cache-dir ".[womblex]"; fi

ENV S3_ENDPOINT=http://minio:9000 \
    S3_ACCESS_KEY=minioadmin \
    S3_SECRET_KEY=minioadmin \
    REDLINE_BUCKET=redline \
    WOMBLEX_MODE=stub \
    HOST=0.0.0.0 \
    PORT=8000

# ISAACUS build arg flips the default extraction mode to real; womblex still runs
# without an Isaacus key (edge/offline mode) unless ISAACUS_API_KEY is set.
RUN if [ "$ISAACUS" = "1" ]; then echo "WOMBLEX_MODE=real" >> /etc/environment; fi

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health',timeout=4).status==200 else 1)"]

CMD ["uvicorn", "womblex_ingest.asgi:app", "--host", "0.0.0.0", "--port", "8000"]
