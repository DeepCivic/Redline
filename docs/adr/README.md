# Architecture Decision Records

This project adopts **Wayfinder's ADR model** (see `vendor/wayfinder/docs/development/adr/`).

## Format

Each ADR is a file named `NNN-short-title.adr.md` and follows:

```
# ADR-NNN — Title

- **Status**: Proposed | Accepted | Accepted — amended by ADR-XXX | Superseded by ADR-XXX
- **Date**: YYYY-MM-DD
- **Amends**: ADR-YYY (optional — what it changes, and what still stands)

## Context
## Decision
## Consequences   (Positive / Negative)
## Alternatives considered   (optional)
## Enforcement   (optional)
```

- ADRs are immutable once **Accepted**. To change a decision, write a new ADR
  that supersedes the old one and flip the old one's status to
  `Superseded by ADR-XXX`.
- **Partial change — amendment.** When a new ADR overturns only *part* of an
  accepted one and the rest still stands, superseding wholesale would discard
  reasoning that is still true. Instead the new ADR carries an **Amends** line
  naming exactly what it changes, and the old one's status becomes
  `Accepted — amended by ADR-XXX` with the same detail. The amended ADR's body is
  still not edited. First use: ADR-0009 amends ADR-0004 on the lifetime of a
  `RequirementSet`.
- Numbers are zero-padded and monotonic.

## Lifecycle

Most ADRs are **preconditions**: drafted at planning (`/new-thread`) at status
**Proposed**, reviewed (`/doc-review`), approved, then built — `/build` flips
them to **Accepted** in the thread's commit and must not build past an unapproved
one. Some are **discovered** during a build, when contact with the code forces a
choice that could not honestly have been made in advance (ADR-0002 and ADR-0003
were both locked mid-thread); those are recorded in the thread's own commit.
ADR-0007 to ADR-0009 are **track-level** — they gate many threads and belong to
none, so they were written once, ahead of the track.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-adapter-over-wayfinder.adr.md) | Adapter over Wayfinder (not a fork) + Strategy A consumption | Accepted — amended by [0012](./0012-wayfinder-is-pinned-and-optional.adr.md) |
| [0002](./0002-own-minio-and-postgres.adr.md) | redline owns its MinIO bucket and Postgres, not Wayfinder's | Accepted |
| [0003](./0003-parquet-to-json-boundary.adr.md) | The womblex extraction boundary is JSON (sidecar reads Parquet, serves JSON) | Accepted — amended by [0014](./0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) |
| [0004](./0004-user-defined-requirements-not-fixed-1-6.adr.md) | Requirements are user-defined criteria (not a fixed 1–6 profile) | Accepted — amended by [0009](./0009-numbatch-library-is-system-of-record.adr.md) |
| [0005](./0005-numbatch-fork-all-but-frontend.adr.md) | Numbatch is a vendored fork; run all-but-frontend, bootstrap via API | Accepted — amended by [0013](./0013-numbatch-fork-is-materialised-from-a-pin.adr.md) |
| [0006](./0006-inherit-wayfinder-auth-roles.adr.md) | Auth/roles: inherit Wayfinder's, do not build our own | Accepted |
| [0007](./0007-procurement-purpose-lens-means.adr.md) | Procurement is the purpose; the comprehension lens is the means | Accepted |
| [0008](./0008-trained-classifier-is-an-optional-overlay.adr.md) | The trained classifier is an optional overlay; the first pass needs no samples | Accepted |
| [0009](./0009-numbatch-library-is-system-of-record.adr.md) | Numbatch's topic library is the system of record for topics, samples and corrections | Accepted |
| [0010](./0010-topic-identity-carries-into-the-requirement-projection.adr.md) | A topic's identity carries into the requirement it projects to | Accepted |
| [0011](./0011-hard-rule-precedence-is-specificity-then-declaration-order.adr.md) | Hard-rule precedence is specificity, then declaration order | Accepted |
| [0012](./0012-wayfinder-is-pinned-and-optional.adr.md) | Wayfinder is pinned by commit and optional at install time | Accepted |
| [0013](./0013-numbatch-fork-is-materialised-from-a-pin.adr.md) | The Numbatch fork is materialised from a pin, not a submodule | Accepted |
| [0014](./0014-embeddings-cross-the-json-boundary-as-float-arrays.adr.md) | Embeddings cross the JSON boundary as plain float arrays on a sibling resource | Accepted |
