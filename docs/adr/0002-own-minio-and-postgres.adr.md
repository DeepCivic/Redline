# ADR-0002 — redline owns its MinIO bucket and Postgres, not Wayfinder's

- **Status**: Accepted
- **Date**: 2026-07-24

## Context

Build plan §8 decision #4 — *"Shared vs separate MinIO/Postgres — share Wayfinder's
MinIO bucket & Postgres (different prefix/schema) vs stand up its own?"* — is marked
**decide before Thread 3 / Thread 9**. Thread 3 (the womblex sidecar) is the first
component that writes to object storage: it lands Parquet shards under
`proc/{evaluationId}/`, so the bucket ownership question must be answered now.

ADR-0001 commits us to building with Strategy A (typed reuse) but designing every
runtime seam **as if C** — fully runtime-decoupled from Wayfinder. Sharing a live
Wayfinder MinIO bucket or Postgres instance would couple our runtime to a running
Wayfinder deployment, contradicting that principle and complicating the Thread 16
standalone extraction.

## Decision

**redline stands up its own MinIO and its own Postgres.** We do not read from or
write into Wayfinder's buckets or databases.

- **Object storage:** a redline-owned MinIO service (compose service `minio`), with a
  single bucket `redline` (override `REDLINE_BUCKET`). womblex shards land under the
  key prefix `proc/{evaluationId}/` within that bucket.
- **Database:** a redline-owned Postgres (added in Thread 9), with all tables under the
  `redline_` prefix (already enforced by `validate.sh` check #7). No shared schema with
  Wayfinder.
- **The seam stays S3/Postgres-shaped, not Wayfinder-shaped.** We depend on the
  `IObjectStorage` *shape* (an S3 API), never on a Wayfinder-hosted endpoint. Any
  deployment that wants to point redline at a shared MinIO can do so purely by
  configuration (`S3_ENDPOINT`, credentials, `REDLINE_BUCKET`) — the code assumes
  nothing about co-tenancy.

## Consequences

**Positive**

- redline runs and is testable with zero Wayfinder infrastructure present — the
  Thread 3 exit test (`compose up`, POST docs, shards land in MinIO) needs only
  redline's own compose stack.
- Clean path to the Thread 16 standalone workspace: no shared-instance assumptions
  to unpick.
- No risk of colliding with, or corrupting, Wayfinder object/DB state during
  development.

**Negative**

- Two MinIO/Postgres instances run in a combined deployment. Acceptable: they are
  cheap, and configuration can still point both at one physical instance in
  production because the seam is plain S3/Postgres.

## Alternatives considered

- **Share Wayfinder's MinIO bucket + Postgres schema (different prefix).** Rejected
  for the build phase: couples our runtime to a live Wayfinder, contradicts the
  "design as if C" principle, and makes the Thread 3/9 exit tests depend on Wayfinder
  being up. Configuration can still collapse to a shared instance later without a
  code change, so nothing is lost.

## Enforcement

- The womblex sidecar reads its S3 target from env (`S3_ENDPOINT`,
  `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `REDLINE_BUCKET`) — never a hardcoded
  Wayfinder endpoint.
- `infra/docker-compose.yml` defines a redline-owned `minio` service; the sidecar
  depends on it, not on any external bucket.
- Table-prefix isolation remains enforced by `validate.sh` check #7 (`redline_`).
