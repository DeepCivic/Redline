#!/usr/bin/env python3
"""Bootstrap a Numbatch profile from a redline RequirementSet, idempotently.

Turns an evaluation's user-defined requirements (+ curated example passages) into a
trained Numbatch profile, entirely over the backend API — no DB seeds
(ADR-0005). Prints the requirementId -> topic_id mapping and the profile_id, which
together are the NumbatchProfileBinding the NumbatchClassifier adapter is
constructed with.

Endpoints used (verified against Numbatch's docs/ARCHITECTURE.md):
  POST /topics                       {name, description}          -> {id, ...}
  POST /topics/{id}/samples          {samples: [{text}, ...]}
  POST /profiles                     {name, description, topic_ids, model_settings?}
  POST /profiles/{id}/train                                       -> {id (training job), ...}
  GET  /training-jobs/{id}                                        -> {status, ...}

Re-running is safe: Numbatch dedupes sample inserts on provenance/text, and
topic/profile names are unique per org among live rows — so an existing topic or
profile is reused rather than duplicated.

stdlib only (urllib) — this runs beside the Numbatch stack, not inside redline's
TypeScript workspace.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any


class NumbatchError(RuntimeError):
    pass


def _request(base_url: str, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    url = f"{base_url.rstrip('/')}{path}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(request) as response:  # noqa: S310 (trusted internal host)
            raw = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise NumbatchError(f"{method} {path} -> HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise NumbatchError(f"{method} {path} -> unreachable: {error.reason}") from error
    return json.loads(raw) if raw else None


def _find_existing(base_url: str, path: str, name: str) -> dict[str, Any] | None:
    # Numbatch list endpoints hide soft-deleted rows and enforce unique live names,
    # so a name match on the live list is the idempotency key.
    existing = _request(base_url, "GET", path)
    items = existing if isinstance(existing, list) else existing.get("items", [])
    for item in items:
        if item.get("name") == name:
            return item
    return None


def ensure_topic(base_url: str, name: str, definition: str) -> str:
    found = _find_existing(base_url, "/topics", name)
    if found is not None:
        return found["id"]
    created = _request(base_url, "POST", "/topics", {"name": name, "description": definition})
    return created["id"]


def add_samples(base_url: str, topic_id: str, samples: list[str]) -> None:
    if not samples:
        return
    # ON CONFLICT DO NOTHING on the Numbatch side makes this a no-op on re-run.
    _request(
        base_url,
        "POST",
        f"/topics/{topic_id}/samples",
        {"samples": [{"text": text} for text in samples]},
    )


def ensure_profile(
    base_url: str, name: str, description: str, topic_ids: list[str], model_settings: dict[str, Any] | None
) -> str:
    found = _find_existing(base_url, "/profiles", name)
    if found is not None:
        return found["id"]
    payload: dict[str, Any] = {"name": name, "description": description, "topic_ids": topic_ids}
    if model_settings:
        payload["model_settings"] = model_settings
    created = _request(base_url, "POST", "/profiles", payload)
    return created["id"]


def train_and_wait(base_url: str, profile_id: str, poll_seconds: float, max_attempts: int) -> None:
    job = _request(base_url, "POST", f"/profiles/{profile_id}/train")
    job_id = job["id"]
    for _ in range(max_attempts):
        status = _request(base_url, "GET", f"/training-jobs/{job_id}")["status"]
        if status == "succeeded":
            return
        if status == "failed":
            raise NumbatchError(f"training job {job_id} failed")
        time.sleep(poll_seconds)
    raise NumbatchError(f"training job {job_id} did not finish within the poll budget")


def bootstrap(base_url: str, spec: dict[str, Any], poll_seconds: float, max_attempts: int) -> dict[str, Any]:
    requirements = spec["requirements"]
    if not requirements:
        raise NumbatchError("spec has no requirements")
    if len(requirements) > 10:
        raise NumbatchError("a Numbatch profile bundles at most 10 topics (ADR-0004)")

    topic_to_requirement: dict[str, str] = {}
    topic_ids: list[str] = []
    for requirement in requirements:
        topic_id = ensure_topic(base_url, requirement["name"], requirement["definition"])
        add_samples(base_url, topic_id, requirement.get("samples", []))
        topic_to_requirement[topic_id] = requirement["requirementId"]
        topic_ids.append(topic_id)

    profile_id = ensure_profile(
        base_url,
        spec["profileName"],
        spec.get("description", f"redline evaluation {spec.get('evaluationId', '')}").strip(),
        topic_ids,
        spec.get("modelSettings"),
    )
    train_and_wait(base_url, profile_id, poll_seconds, max_attempts)

    # The NumbatchProfileBinding the NumbatchClassifier adapter consumes.
    return {
        "profileId": profile_id,
        "strategy": spec.get("strategy", "majority_vote"),
        "topicToRequirement": topic_to_requirement,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Numbatch backend base URL")
    parser.add_argument("--spec", required=True, help="path to the evaluation spec JSON")
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    parser.add_argument("--max-attempts", type=int, default=240)
    args = parser.parse_args()

    with open(args.spec, encoding="utf-8") as handle:
        spec = json.load(handle)

    try:
        binding = bootstrap(args.base_url, spec, args.poll_seconds, args.max_attempts)
    except NumbatchError as error:
        print(f"bootstrap failed: {error}", file=sys.stderr)
        return 1

    print(json.dumps(binding, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
