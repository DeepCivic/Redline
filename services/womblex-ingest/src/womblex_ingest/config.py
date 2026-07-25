"""Process configuration, read from the environment at startup.

Per ADR-0002 the S3 target is fully config-driven — the sidecar never assumes a
Wayfinder-hosted endpoint. `WOMBLEX_MODE` selects the extractor; it defaults to
`stub` so the service starts (and the exit test passes) without the heavy womblex
dependency or an Isaacus key.

Thread 15 makes Isaacus-optionality explicit: womblex runs with or without Isaacus
enrichment, so `enrichment_mode` derives the live path from `WOMBLEX_MODE` + the
presence of an `ISAACUS_API_KEY`. The stub path is always offline; the real path
is offline unless a non-blank key is supplied. `/health` surfaces the mode so a
deployment (and the UI toggle) can read which path is live, and the air-gap exit
test proves the whole pipeline runs with the key unset.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from typing import Optional


class EnrichmentMode(str, Enum):
    """Whether womblex enrichment calls Isaacus or stays fully offline.

    OFFLINE is the air-gapped default (Thread 15): no Isaacus API key required,
    the whole pipeline runs disconnected. ISAACUS is opt-in and needs both the
    real extractor and a key.
    """

    OFFLINE = "offline"
    ISAACUS = "isaacus"


@dataclass(frozen=True)
class Settings:
    s3_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    bucket: str
    womblex_mode: str
    isaacus_api_key: Optional[str]

    @property
    def isaacus_enabled(self) -> bool:
        """Isaacus is live only in real mode with a non-blank key present."""
        if self.womblex_mode != "real":
            return False
        return bool(self.isaacus_api_key and self.isaacus_api_key.strip())

    @property
    def enrichment_mode(self) -> EnrichmentMode:
        return EnrichmentMode.ISAACUS if self.isaacus_enabled else EnrichmentMode.OFFLINE

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            s3_endpoint=os.environ.get("S3_ENDPOINT", "http://minio:9000"),
            s3_access_key=os.environ.get("S3_ACCESS_KEY", "minioadmin"),
            s3_secret_key=os.environ.get("S3_SECRET_KEY", "minioadmin"),
            bucket=os.environ.get("REDLINE_BUCKET", "redline"),
            womblex_mode=os.environ.get("WOMBLEX_MODE", "stub"),
            isaacus_api_key=os.environ.get("ISAACUS_API_KEY"),
        )
