"""Settings tests — the `/health` diagnostics read straight off these."""

from __future__ import annotations

import pytest

from womblex_ingest import config
from womblex_ingest.config import Settings


def make_settings(**overrides: object) -> Settings:
    base: dict[str, object] = {
        "s3_endpoint": "http://minio:9000",
        "s3_access_key": "minioadmin",
        "s3_secret_key": "minioadmin",
        "bucket": "redline",
        "womblex_mode": "real",
        "isaacus_api_key": "iuak_v1_test",
        "redline_database_url": None,
        "womblex_db_dsn": None,
        "womblex_store_uri": None,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def test_isaacus_disabled_in_stub_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "isaacus_sdk_installed", lambda: True)

    assert make_settings(womblex_mode="stub").isaacus_enabled is False


def test_isaacus_disabled_without_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "isaacus_sdk_installed", lambda: True)

    assert make_settings(isaacus_api_key=None).isaacus_enabled is False
    assert make_settings(isaacus_api_key="   ").isaacus_enabled is False


# The regression this file exists for. A key alone was reported as enabled, so an
# image built without the engine's `isaacus` extra served
# `isaacusEnabled: true` while `womblex.utils.availability.isaacus_available()`
# returned false — the chunk stage then failed the run with a key sitting right
# there in the environment. The diagnostic has to answer the same question the
# engine asks, or it sends its reader somewhere else entirely.
def test_isaacus_disabled_when_the_sdk_is_not_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "isaacus_sdk_installed", lambda: False)

    assert make_settings().isaacus_enabled is False


def test_isaacus_enabled_with_both_the_sdk_and_a_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "isaacus_sdk_installed", lambda: True)

    assert make_settings().isaacus_enabled is True
