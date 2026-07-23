"""ASGI entrypoint: `uvicorn womblex_ingest.asgi:app`."""

from __future__ import annotations

from womblex_ingest.main import build_app_from_env

app = build_app_from_env()
