"""Process configuration, read from the environment at startup.

Per ADR-0002 the S3 target is fully config-driven — the sidecar never assumes a
Wayfinder-hosted endpoint. `WOMBLEX_MODE` selects the extractor; it defaults to
`stub` so the service starts (and the exit test passes) without the heavy womblex
dependency or an Isaacus key.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    bucket: str
    womblex_mode: str

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            s3_endpoint=os.environ.get("S3_ENDPOINT", "http://minio:9000"),
            s3_access_key=os.environ.get("S3_ACCESS_KEY", "minioadmin"),
            s3_secret_key=os.environ.get("S3_SECRET_KEY", "minioadmin"),
            bucket=os.environ.get("REDLINE_BUCKET", "redline"),
            womblex_mode=os.environ.get("WOMBLEX_MODE", "stub"),
        )
