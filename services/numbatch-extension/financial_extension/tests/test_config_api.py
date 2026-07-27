"""Config API tests — the Thread 6 exit test: create a financial profile via API."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _valid_profile(topic_id: str = "topic-data-residency") -> dict:
    return {
        "topic_id": topic_id,
        "name": "Data residency costs",
        "description": "Hosting and residency-related line items.",
        "target_currency": "AUD",
        "cost_basis": "recurring",
        "granularity": "line_item",
    }


def test_create_financial_profile_for_a_topic(client: TestClient) -> None:
    response = client.post("/financial-profiles", json=_valid_profile())

    assert response.status_code == 201
    body = response.json()
    assert body["id"]
    assert body["topic_id"] == "topic-data-residency"
    assert body["target_currency"] == "AUD"
    assert body["cost_basis"] == "recurring"
    assert body["granularity"] == "line_item"


def test_create_defaults_cost_basis_and_granularity(client: TestClient) -> None:
    response = client.post(
        "/financial-profiles",
        json={
            "topic_id": "topic-support",
            "name": "Support & SLA costs",
            "target_currency": "AUD",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["cost_basis"] == "one_off"
    assert body["granularity"] == "bundle"
    assert body["description"] == ""


def test_create_is_idempotent_per_topic(client: TestClient) -> None:
    first = client.post("/financial-profiles", json=_valid_profile())
    second = client.post("/financial-profiles", json=_valid_profile())

    assert first.status_code == 201
    # Re-creating for the same topic returns the existing profile, not a dupe.
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]


def test_list_financial_profiles(client: TestClient) -> None:
    client.post("/financial-profiles", json=_valid_profile("topic-a"))
    client.post("/financial-profiles", json=_valid_profile("topic-b"))

    response = client.get("/financial-profiles")

    assert response.status_code == 200
    topic_ids = {profile["topic_id"] for profile in response.json()}
    assert topic_ids == {"topic-a", "topic-b"}


def test_read_financial_profile_by_id(client: TestClient) -> None:
    created = client.post("/financial-profiles", json=_valid_profile()).json()

    response = client.get(f"/financial-profiles/{created['id']}")

    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


def test_read_unknown_profile_is_404(client: TestClient) -> None:
    response = client.get("/financial-profiles/does-not-exist")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_create_rejects_blank_topic_id(client: TestClient) -> None:
    response = client.post(
        "/financial-profiles",
        json={"topic_id": "", "name": "x", "target_currency": "AUD"},
    )

    assert response.status_code == 422


def test_create_rejects_malformed_currency(client: TestClient) -> None:
    response = client.post(
        "/financial-profiles",
        json={"topic_id": "topic-x", "name": "x", "target_currency": "dollars"},
    )

    assert response.status_code == 422
