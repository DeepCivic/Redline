# womblex-ingest money-annotation image (the `money` compose service).
#
# WHY THIS IS A SEPARATE DOCKERFILE FROM services/womblex-ingest/Dockerfile:
# it is built from the REPO ROOT context because it needs two source trees at
# once — the womblex engine (services/womblex, the submodule) and the sidecar
# package (services/womblex-ingest). The sidecar's own Dockerfile has only its
# own directory as context and cannot reach the engine source, so the money
# image, which needs both, lives here.
#
# WHY IT INSTALLS THE ENGINE FROM SOURCE: womblex publishes no release to any
# index, so a version requirement could not be resolved. The submodule source is
# the only installable form — and it is the same source the engine image (the
# `womblex` compose service) is built from, so the money stage annotates with the
# exact engine the shards were extracted by.
#
# WHAT IT RUNS: `python -m womblex_ingest.money_stage` stages an evaluation's
# `*.elements` / `*.table_cells` shards down from object storage, runs womblex's
# own `money_shards()`, publishes the `*.money_spans` / `*.money_columns`
# siblings back beside them, and loads the spans into `redline_money_spans`. That
# store load is redline's — the engine's generic `run-stage` has no equivalent.
#
# The money stage runs `money_shards()` over already-extracted `*.elements` /
# `*.table_cells` parquet shards — it never loads an OCR/tokeniser model, so this
# image ships no models/ dir and sets no WOMBLEX_MODELS_DIR. python:3.11-slim
# matches the engine image: womblex's dependencies have wheels for 3.11/3.12 only.
FROM python:3.11-slim AS money

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# OpenCV (headless) + PyMuPDF need libglib/libGL at import time, same as the
# engine image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The engine, from the submodule source. `cloud` gives RemoteStore + S3 staging,
# which money_stage.py uses to move shards between object storage and its scratch
# dir. The default omits `isaacus`: the money op is offline and API-free, and the
# extra drags boto3 in for nothing.
#
# It is an ARG, not a constant, because this image has a second consumer. The
# run-capable sidecar (infra/docker-compose.run-sidecar.yml) serves the run
# trigger from it, and that trigger drives chunk/embed/enrich — all Isaacus
# stages. `isaacus_available()` tests the SDK BEFORE the key, so a run-serving
# build without this extra fails at the chunk stage holding a valid key. Matches
# services/womblex/Dockerfile, which takes the same ARG for the same reason.
ARG EXTRAS=cloud
COPY services/womblex /app/womblex-engine
RUN pip install "./womblex-engine[${EXTRAS}]"

# The sidecar package brings the money_stage module and its own deps (boto3,
# psycopg, pyarrow). It declares no engine dependency of its own — the engine is
# already present from source above.
COPY services/womblex-ingest/pyproject.toml /app/sidecar/
COPY services/womblex-ingest/src /app/sidecar/src
RUN pip install "./sidecar"

# The compose service overrides this with its --evaluation-id argument; stated
# here so the image is runnable alone.
ENTRYPOINT ["python", "-m", "womblex_ingest.money_stage"]
