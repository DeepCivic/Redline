# Architecture Decision Records

This project adopts **Wayfinder's ADR model** (see `vendor/wayfinder/docs/development/adr/`).

## Format

Each ADR is a file named `NNN-short-title.adr.md` and follows:

```
# ADR-NNN — Title

- **Status**: Proposed | Accepted | Superseded by ADR-XXX
- **Date**: YYYY-MM-DD

## Context
## Decision
## Consequences   (Positive / Negative)
## Alternatives considered   (optional)
## Enforcement   (optional)
```

- ADRs are immutable once **Accepted**. To change a decision, write a new ADR
  that supersedes the old one and flip the old one's status to
  `Superseded by ADR-XXX`.
- Numbers are zero-padded and monotonic.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-adapter-over-wayfinder.adr.md) | Adapter over Wayfinder (not a fork) + Strategy A consumption | Accepted |
