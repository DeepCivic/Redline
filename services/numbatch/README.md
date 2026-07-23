# numbatch (vendored fork)

The **Numbatch** classification engine (DeepCivic/Numbatch), vendored as a fork.
redline runs its **backend API + Arq worker + inference service** (plus Postgres +
Redis, reusing redline's MinIO) and **never** its SvelteKit frontend — redline owns its
own control surface and review grid ([ADR-0005](../../docs/adr/0005-numbatch-fork-all-but-frontend.adr.md)).

> **Not committed here during the build phase.** Like `vendor/wayfinder`, the fork's
> tree is large and lives in its own remote; it is added as a submodule / sibling
> checkout, and its `infra/docker/*.Dockerfile`s are referenced by redline's compose
> `numbatch` profile. Thread 16 finalises how the fork ships. This directory currently
> holds only this README and the bootstrap script.

## What Numbatch is (verified from its docs)

A **topic** = name + description + curated training samples → a LoRA adapter. A
**profile** bundles ≤10 ordered topics and trains one adapter. Batch inference classifies
ingested chunks and rolls per-chunk predictions up into per-document classifications
keyed on `source_doc_id` (Womblex's `source_hash`), each with a score and `chunks_matched`
(`docs/DATA_MODEL.md` `document_classifications`; `docs/ARCHITECTURE.md`).

A redline **requirement/criterion** ⇔ a Numbatch **topic**; an evaluation's
`RequirementSet` ⇔ a Numbatch **profile** (≤10) ([ADR-0004](../../docs/adr/0004-user-defined-requirements-not-fixed-1-6.adr.md)).

## Running it (all-but-frontend)

```sh
podman compose -f ../../infra/docker-compose.yml --profile numbatch up -d
# backend API on :8080, inference on :8100 — no frontend
```

Numbatch's ingestion feed points at redline's MinIO bucket (`S3_WOMBLEX_BUCKET =
redline`), so it reads the same `proc/{evaluationId}/*.chunks.parquet` the womblex
sidecar wrote.

## Bootstrapping an evaluation's profile (idempotent)

`bootstrap-profile.py` turns a redline `RequirementSet` (+ curated example passages per
requirement) into a **trained Numbatch profile**, entirely over the backend API — no DB
seeds ([ADR-0005](../../docs/adr/0005-numbatch-fork-all-but-frontend.adr.md)):

1. `POST /topics` per requirement (`name` = requirement name, `description` = definition).
2. `POST /topics/{id}/samples` with that requirement's curated example passages.
3. `POST /profiles` with the ordered `topic_id`s (≤10).
4. `POST /profiles/{id}/train`; poll `GET /training-jobs/{id}` to `succeeded`.

It prints the **`requirementId → topic_id` mapping** and the `profile_id` — exactly the
`NumbatchProfileBinding` the `NumbatchClassifier` adapter (`redline-adapters`) is
constructed with. Re-running is safe: Numbatch dedupes sample inserts on
provenance/text and topic/profile names are unique among live rows.

```sh
python bootstrap-profile.py --base-url http://localhost:8080 --spec evaluation-spec.json
```

Where `evaluation-spec.json` is:

```json
{
  "evaluationId": "eval-9",
  "profileName": "eval-9 — procurement criteria",
  "strategy": "majority_vote",
  "requirements": [
    {
      "requirementId": "req-data-residency",
      "name": "Data residency",
      "definition": "Data must be stored and processed within Australia.",
      "samples": ["All data resides in ap-southeast-2 …", "…"]
    }
  ]
}
```

## Financial extension (Threads 6–7)

The forked backend gains `financial_profiles` + `financial_extractions` (keyed on
`(source_doc_id, topic_id)`) and a new Arq worker stage — additive to the schema above,
consumed by the `IFinancialExtractor` adapter (Thread 8).
