"""Isaacus-optional configuration (Thread 15).

womblex runs with or without Isaacus enrichment. These tests pin the rule that
derives the *enrichment mode* from `WOMBLEX_MODE` + the presence of an
`ISAACUS_API_KEY`, so the pipeline degrades cleanly to the offline (air-gapped)
path when the key is unset — and so `/health` can surface which path is live for
a deployment/UI toggle.
"""

from __future__ import annotations

import pytest

from womblex_ingest.config import EnrichmentMode, Settings


def _settings(**overrides: str) -> Settings:
    base = {
        "s3_endpoint": "http://minio:9000",
        "s3_access_key": "minioadmin",
        "s3_secret_key": "minioadmin",
        "bucket": "redline",
        "womblex_mode": "stub",
        "isaacus_api_key": None,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def test_stub_mode_is_always_offline_even_with_a_key() -> None:
    settings = _settings(womblex_mode="stub", isaacus_api_key="secret")

    # The stub extractor never calls Isaacus, so the enrichment path is offline
    # regardless of whether a key happens to be present.
    assert settings.enrichment_mode is EnrichmentMode.OFFLINE
    assert settings.isaacus_enabled is False


def test_real_mode_without_a_key_is_offline() -> None:
    settings = _settings(womblex_mode="real", isaacus_api_key=None)

    assert settings.enrichment_mode is EnrichmentMode.OFFLINE
    assert settings.isaacus_enabled is False


def test_real_mode_with_a_key_enables_isaacus() -> None:
    settings = _settings(womblex_mode="real", isaacus_api_key="isaacus-key")

    assert settings.enrichment_mode is EnrichmentMode.ISAACUS
    assert settings.isaacus_enabled is True


def test_a_blank_key_is_treated_as_unset() -> None:
    settings = _settings(womblex_mode="real", isaacus_api_key="   ")

    assert settings.enrichment_mode is EnrichmentMode.OFFLINE
    assert settings.isaacus_enabled is False


def test_from_env_reads_isaacus_key_and_defaults_to_offline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for var in ("WOMBLEX_MODE", "ISAACUS_API_KEY"):
        monkeypatch.delenv(var, raising=False)

    settings = Settings.from_env()

    assert settings.womblex_mode == "stub"
    assert settings.isaacus_api_key is None
    assert settings.enrichment_mode is EnrichmentMode.OFFLINE


def test_from_env_reads_a_present_isaacus_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WOMBLEX_MODE", "real")
    monkeypatch.setenv("ISAACUS_API_KEY", "isaacus-key")

    settings = Settings.from_env()

    assert settings.isaacus_api_key == "isaacus-key"
    assert settings.enrichment_mode is EnrichmentMode.ISAACUS
