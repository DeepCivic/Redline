# ADR-0007 — Procurement is the purpose; the comprehension lens is the means

- **Status**: Accepted
- **Date**: 2026-07-24

## Context

redline was scoped as a **Procurement Evaluation Adapter**: ingest → classify →
cost → review grid → pivots → Excel. Threads 1–11 delivered that vertical's
foundations (domain, sidecar, classifier, financial extension, persistence,
orchestration, control surface), but **nothing usable end-to-end**. Under the
original sequencing, a specialist gets value only after Threads 12–14 — the
review grid, pricing pivots, and export — because everything before them is
plumbing.

A proposed workflow ("Essentials") described a different shape: define a few
topics, let the system sort the obvious documents, surface only genuine
collisions, remember the resolutions. Reviewing it against the upstream engines
showed that this **comprehension loop is usable on its own, and much earlier**
than the procurement grid — it needs no costing, no export, and (per
[ADR-0008](./0008-trained-classifier-is-an-optional-overlay.adr.md)) no trained
classifier.

That raised a genuine identity question: does redline become a general
corpus-comprehension tool whose first vertical happens to be procurement, or does
it stay procurement-first and adopt the lens as an architecture? The two readings
produce different roadmaps, different scope arguments, and different answers to
"is this feature in scope?".

## Decision

**redline is built in service of procurement evaluation. The comprehension lens
is the composable architecture that delivers it sooner — the means, not the
purpose.**

- The repo's identity remains procurement-first. `CLAUDE.md` and `README.md`
  describe a procurement evaluation adapter *built as* a composable lens.
- A procurement **requirement** is a lens **topic**; a `RequirementSet` is a lens
  bound to an evaluation. The review grid, pricing pivots, and Excel export
  (Threads 12–14) sit on top unchanged.
- **Generalising the lens beyond procurement is not a goal.** Generality is a
  property the design happens to have. It is not to be pursued at procurement's
  expense, and it is not a justification for scope on its own.
- Where a lens capability and a procurement need conflict, procurement wins.

## Consequences

**Positive**

- A usable solution lands sooner: the sort-and-resolve loop works before the
  classifier is trained, before costing, and before the grid — so the earliest
  demonstrable value no longer waits on Threads 12–14.
- Scope arguments have a default resolution. "Would this help a general corpus
  user?" is not a reason to build something; "does this serve the procurement
  specialist?" is.
- The composable seams (independent operations over joinable sidecars) make each
  thread smaller and independently testable, which suits the one-thread-one-agent
  build model.

**Negative**

- The architecture carries generality we deliberately do not exploit. That is a
  standing temptation to scope-creep, and this ADR is the thing to point at when
  it happens.
- Lens work whose payoff is cross-corpus (notably lens portability, Thread 30)
  must justify itself in procurement terms — repeated evaluations by the same
  specialist — rather than on generality alone.
- Some of the vocabulary is now dual ("requirement" in procurement, "topic" in
  the lens and in Numbatch). The translation is confined to the adapter boundary,
  as [ADR-0004](./0004-user-defined-requirements-not-fixed-1-6.adr.md) already
  requires.

## Alternatives considered

- **redline becomes a corpus-comprehension product; procurement is its first
  vertical.** Rejected: it trades procurement delivery time for generality no
  user has asked for, and it would make every future scope call ambiguous.
- **Keep the lens as internal machinery, never surfaced to the user.** Rejected:
  the collision-resolution loop *is* the user-facing value that arrives early.
  Hiding it would preserve the original identity at the cost of the very thing
  that makes a solution usable sooner.

## Enforcement

- `CLAUDE.md` Project Identity and `README.md` state the purpose/means relation
  explicitly; the design doc records it as decision **D1**.
- The design doc's non-goals (§8) list generalisation beyond procurement, with a
  re-entry condition.
- `/new-thread` sizes and justifies threads against procurement delivery; a
  thread whose only rationale is cross-domain generality does not pass.
