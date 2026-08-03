# ADR-0020 — Cold-start topic definitions are redline-owned; Numbatch's library is the system of record for the trained overlay

- **Status**: Proposed
- **Date**: 2026-08-05
- **Amends**: [ADR-0009](./0009-numbatch-library-is-system-of-record.adr.md) on the
  scope of *"topics"* — its rulings on samples, corrections and the
  no-two-way-sync principle stand unchanged

## Context

[ADR-0009](./0009-numbatch-library-is-system-of-record.adr.md) settled that
Numbatch's org-scoped library is the system of record for `topics`,
`topic_samples` and `feedback_corrections`, and that redline's `redline_` tables
hold *"the lens (its identity, its criteria references, its hard rules, its
boundary decisions) and the bindings"* — **references, not copies**. Its
*Alternatives considered* explicitly rejected mirroring the library into
`redline_` tables, because that introduces a two-way sync and a duplicate source
of truth.

The lean vertical (`delivery-plan.md` §2) excludes the Numbatch stack entirely.
Classification runs [ADR-0008](./0008-trained-classifier-is-an-optional-overlay.adr.md)'s
first pass: hard rules plus LLM adjudication, no samples, no training, no
adapter. That path needs **topic definition text at classification time**.
`ColdStartClassifier` builds its `AdjudicationCandidate`s as
`{ topicId, name, definition }` from the lens's topics and hands them to
`IAdjudicator`; the port's own contract is that the model reasons over each
candidate's name and definition and picks one. A bare `topic_id` reference
cannot produce that text.

So on the lean path there is no system of record to dereference. ADR-0009
half-anticipates the tension — *"under ADR-0008 the first pass needs no Numbatch
at all, so a lens stays definable, usable and improvable with the fork down"* —
but it does not say where the definition text lives when the fork is down, and a
lens that is *definable* without Numbatch must store its definitions somewhere.

This is not a hypothetical. It blocks `delivery-plan.md` §2 item 1: the schema
behind `IClassificationLensReader` cannot be drawn until it is settled, because
the answer decides whether `redline_` holds definition text at all.

## Decision

**Cold-start topic definitions are redline-owned. Numbatch's library is the
system of record for the trained overlay's topics, samples and corrections.**

- A lens's topics — `name` and `definition` — are stored in `redline_` tables and
  are redline's own data. They are the material `ColdStartClassifier` adjudicates
  over, and they exist whether or not Numbatch is deployed.
- Numbatch's library remains the system of record for **`topic_samples` and
  `feedback_corrections` unconditionally**, and for the topic rows of the
  *trained* overlay. ADR-0009's ruling on those is untouched.
- When the trained overlay re-enters, a redline topic gains an **optional
  reference** to its Numbatch `topic_id`, carried as its own binding row — not a
  column that presumes the fork exists. Bootstrap pushes redline's definitions
  **into** Numbatch to create the library rows; nothing is read back and
  overwritten.

**Why this is not the mirroring ADR-0009 rejected.** Mirroring means copying
library rows into `redline_` and keeping both in step — two writers, one truth,
a sync to debug. Here the flow is one-way and the sets are disjoint in
ownership: a cold-start definition **originates in redline** and has no library
counterpart until bootstrap creates one from it. There is no second writer,
because Numbatch never authors a cold-start definition. ADR-0009's actual
objection — a duplicate source of truth — does not arise.

**Schema consequence for §2 item 1.** `redline_` holds the lens identity, its
topics (id, name, definition), its hard rules, and the lens↔evaluation binding.
Standard conventions apply: `redline_` prefix, snake_case columns,
`id`/`created_at`/`updated_at` on every table. A `Lens` still carries no
`evaluationId` — the binding is its own row (ADR-0009, unchanged). `candidates`
remain derived per call from the request's `documentIds`, never stored
— this decision does not change what `IClassificationLensReader` returns.

## Consequences

**Positive**

- The lean vertical becomes buildable. A lens is definable, persistable and
  usable with no Numbatch anywhere — which is what ADR-0008's first pass promised
  and what §2 assumes.
- The adjudicator gets real definition text rather than a name, which is the
  difference between a model choosing on meaning and choosing on a label.
- ADR-0009's expensive parts survive intact: no two-way sync, no duplicated
  samples, no reimplementation of Numbatch's dedupe and soft-delete.
- The trained overlay's re-entry is additive — a binding row and a bootstrap
  push, not a migration of ownership.

**Negative**

- Topic identity now has two possible homes, and a reader must know which one
  applies. Mitigated by the split being by *kind* (cold-start definitions vs
  library samples/corrections), not by instance.
- If a specialist edits a definition in redline after bootstrap has pushed it,
  redline and the library drift. Accepted for now: the trained overlay is
  deferred (§3), and the re-push semantics belong to the *Train/activate policy*
  item that owns bootstrap. This ADR does not settle them.
- ADR-0009's tenancy gap is unchanged and still open — Numbatch's
  `organisation_id` scoping versus Wayfinder identity still needs its own
  decision before a lens is shared between users (`delivery-plan.md` §4 item 1).

## Alternatives considered

- **Leave ADR-0009 unchanged and require Numbatch for cold start.** Rejected: it
  contradicts ADR-0008 (*"the first pass needs no samples, no training, no
  adapter"*) and §2's explicit exclusion of the Numbatch stack. It would make the
  lean vertical depend on the very stack it exists to avoid.
- **Store references only; have the adjudicator reason from topic names.**
  Rejected: `IAdjudicator`'s contract is that the model reads a definition. A
  name is a label, not a definition, and adjudication quality is the whole of the
  cold-start path's accuracy.
- **Mirror Numbatch's library into `redline_` tables and sync.** Rejected for
  ADR-0009's original reason, which still holds: two writers over one truth.
- **Put definitions in a config file rather than the database.** Rejected: a lens
  is authored and edited by a specialist, is per-deployment, and must be bound to
  evaluations by id — that is data, not configuration.

## Enforcement

- §2 item 1's exit test — a lens saved with its hard rules and its evaluation
  binding reading back byte-identical through `IClassificationLensReader` — is
  the proof the definitions round-trip.
- No `redline_` table stores Numbatch **samples** or **corrections**
  (ADR-0009's rule, unchanged); `validate.sh` #7 continues to hold every table to
  the `redline_` prefix.
- The Numbatch `topic_id` reference, when the trained overlay lands, is a binding
  row — a schema review that finds it as a column on the topic table should
  reject it.
