"""Process configuration, read from the environment at startup.

Per ADR-0002 the S3 target is fully config-driven — the sidecar never assumes a
Wayfinder-hosted endpoint. `WOMBLEX_MODE` selects the extractor; it defaults to
`stub` so the service starts (and the exit test passes) without the heavy womblex
dependency or an Isaacus key.

Isaacus is a **hard requirement of the real lane**, not an optional enrichment:
the retrieval leg is womblex's `*.embeddings.parquet`, and the embed stage is
Isaacus-only. A deployment without a key cannot retrieve, which is the whole
first pass — so `isaacus_enabled` is a **diagnostic**, surfaced on `/health` so a
misconfigured deployment is legible, not a mode the product supports running in.
See ADR-0008 (amended) and `docs/architecture.md` §2.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Settings:
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    bucket: str
    womblex_mode: str
    isaacus_api_key: Optional[str]
    # redline's own Postgres (ADR-0002). When set, an ingest projects its chunks +
    # embeddings into the `redline_` chunk store alongside the MinIO
    # shards; when absent (the stub / air-gapped lane), the store step is skipped
    # and only the shards + JSON seam are written — the sidecar still starts.
    redline_database_url: Optional[str]
    # The womblex engine's own queue DSN and object-store base URI. These are the
    # trigger's coupling to the engine (the second engine seam, architecture
    # §2.1): `enqueue`/`worker`/`run-stage` read them. Absent, the sidecar starts
    # without a run trigger and the /runs routes 503 — the read seam still serves.
    womblex_db_dsn: Optional[str]
    womblex_store_uri: Optional[str]

    @property
    def isaacus_enabled(self) -> bool:
        """Isaacus is live only in real mode with a non-blank key present.

        False on the real lane means retrieval cannot run — a misconfiguration
        to surface, not a supported offline mode.
        """
        if self.womblex_mode != "real":
            return False
        return bool(self.isaacus_api_key and self.isaacus_api_key.strip())

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            s3_endpoint=os.environ.get("S3_ENDPOINT", "http://minio:9000"),
            s3_access_key=os.environ.get("S3_ACCESS_KEY", "minioadmin"),
            s3_secret_key=os.environ.get("S3_SECRET_KEY", "minioadmin"),
            bucket=os.environ.get("REDLINE_BUCKET", "redline"),
            womblex_mode=os.environ.get("WOMBLEX_MODE", "stub"),
            isaacus_api_key=os.environ.get("ISAACUS_API_KEY"),
            redline_database_url=os.environ.get("REDLINE_DATABASE_URL"),
            womblex_db_dsn=os.environ.get("WOMBLEX_DB_DSN") or os.environ.get("DATABASE_URL"),
            womblex_store_uri=os.environ.get("WOMBLEX_STORE_URI"),
        )
