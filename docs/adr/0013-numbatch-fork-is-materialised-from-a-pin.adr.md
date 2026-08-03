# ADR-0013 — The Numbatch fork is materialised from a pin, not a submodule

- **Superseded in full** by [ADR-0015](./0015-upstream-python-engines-are-submodules.adr.md) (2026-07-27)
- **Date**: 2026-07-25

> **Superseded.** The consistency argument below copies Wayfinder's mechanism
> without its premise: Wayfinder is pinned because a submodule drags its package
> set into the pnpm workspace, which is a JavaScript problem Numbatch does not
> have. The pin this ADR deferred was never written, and the fork was never
> fetched — leaving a `numbatch` compose profile that could not start. Both
> Python engines are now submodules; see ADR-0015.
- **Amends**: [ADR-0005](./0005-numbatch-fork-all-but-frontend.adr.md) (the Vendoring clause only)

## Context

ADR-0005 settled that `services/numbatch/` is the DeepCivic/Numbatch fork, not
committed here, and described how it arrives: *"added as a submodule / sibling
checkout the same way `vendor/wayfinder` is."*

[ADR-0012](./0012-wayfinder-is-pinned-and-optional.adr.md) removed the thing that
sentence points at. Wayfinder is no longer a submodule — a submodule checkout
drags a repo's entire package set into our pnpm workspace, so it is materialised
at build time from a commit recorded in `wayfinder.pin`. ADR-0005's mechanism
clause now describes machinery that does not exist.

## Decision

**The Numbatch fork is materialised at build time from a recorded commit, by the
same mechanism as Wayfinder. No submodule.**

- Everything else in ADR-0005 stands: the fork is not committed here, redline
  drives it over HTTP, the frontend is never run, and the additive overlay we do
  own (`services/numbatch/financial_extension/`, `bootstrap-profile.py`) stays
  committed as normal source.
- The pin lands when something in this repo first fetches the fork. Nothing does
  today — compose references Dockerfiles under `infra/docker/`, and the overlay
  is tested standalone against SQLite. Writing a `numbatch.pin` now would record
  a commit no script reads.
- When it lands it follows `wayfinder.pin`'s shape (`repo=`, `ref=` at a full
  SHA, read by both the fetch script and CI), so there is one vendoring idiom in
  this repo rather than two.
- Thread 16 still finalises how the fork ships; this fixes only the mechanism it
  inherits.

## Consequences

- One vendoring idiom for both upstreams, and no dead submodule instructions for
  a contributor to follow into a hole.
- Numbatch stays unpinned until the fetch exists — an honest gap, and the reason
  it is called out here rather than papered over with an unread pin file.
- ADR-0005's Vendoring bullet should be read as superseded by this ADR; the rest
  of it is untouched.
