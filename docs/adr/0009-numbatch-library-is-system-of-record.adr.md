# ADR-0009 — Numbatch's topic library is the system of record for topics, samples and corrections

- **Date**: 2026-07-24
- **Amends**: [ADR-0004](./0004-user-defined-requirements-not-fixed-1-6.adr.md)
  on the lifetime of a `RequirementSet` (its user-defined-criteria ruling stands)

## Context

Numbatch (`docs/DATA_MODEL.md`) is built on a deliberate three-tier split:

| Tier | Tables | Lifetime |
|---|---|---|
| **Library** | `topics`, `topic_samples`, `feedback_corrections` | durable, org-scoped, shared across profiles |
| **Bundle** | `profiles`, `profile_topics`, `profile_samples` | disposable, per-use |
| **Results** | `chunk_classifications`, `document_classifications` | ephemeral (30-day purge) |

Topics are soft-deleted *"so historical references survive"*; sample dedupe is
enforced by partial unique indexes (`uq_topic_samples_provenance` on
`(topic_id, source_doc_id, chunk_id)` — the same chunk may feed two different
topics, never the same topic twice); corrections are append-only and never
auto-deleted.

redline flattened all three tiers into a single evaluation-scoped
`RequirementSet` (`packages/redline-domain/src/entities/requirement.ts`), bound
to Numbatch through `NumbatchProfileBinding { profileId, strategy,
topicToRequirement }` and rebuilt per evaluation by `bootstrap-profile.py`. The
consequences were that no topic outlived an evaluation, curated samples existed
only transiently inside the bootstrap script, and there was no counterpart to
Numbatch's correction loop — so a specialist's judgement could not compound.

Restoring that tier raises the question this ADR settles: **where does it live?**
Either redline mirrors topics/samples/decisions into `redline_` tables and
synchronises, or Numbatch's library remains canonical and redline holds
references.

## Decision

**Numbatch's org-scoped library is the system of record. redline persists lens
references and bindings only — not copies.**

- `topics`, `topic_samples` and `feedback_corrections` stay in Numbatch and are
  read and written through its API, consistent with
  [ADR-0005](./0005-numbatch-fork-all-but-frontend.adr.md)'s "bootstrap via API,
  no DB seeds".
- redline's `redline_` tables hold the **lens** (its identity, its criteria
  references, its hard rules, its boundary decisions) and the **bindings**
  (`requirementId ↔ topic_id`, `profile_id`), not the samples themselves.
- Boundary decisions are pushed into the library as sample membership (Thread
  33), inheriting Numbatch's dedupe so re-pushing is a no-op.
- **This amends ADR-0004** on one point: ADR-0004 stated *"an evaluation owns a
  `RequirementSet`"*. It does not — the lens is durable and evaluation-
  independent, and a `RequirementSet` is a **projection** of a lens bound to an
  evaluation. Everything else ADR-0004 decided (user-defined criteria, the ≤10
  cap, `requirementId` in place of `requirementNumber`, requirement ↔ topic
  translated only in the adapter, financial mapping via deduped provenance)
  stands unchanged.

## Consequences

**Positive**

- No two-way sync and no duplicate source of truth — the failure mode that would
  have cost the most to debug.
- redline inherits Numbatch's dedupe and soft-delete guarantees for free rather
  than reimplementing them, which is the same reasoning as
  [ADR-0008](./0008-trained-classifier-is-an-optional-overlay.adr.md): use the
  engine at full strength.
- Procurement delivery time is not spent building lens infrastructure that
  already exists — the direct application of
  [ADR-0007](./0007-procurement-purpose-lens-means.adr.md).
- The correction loop that makes a lens compound is Numbatch's
  corrections-as-sample-membership model, adopted rather than invented.

**Negative**

- **Library operations couple to the fork running.** Mitigated, and deliberately
  so: under ADR-0008 the first pass needs no Numbatch at all, so a lens stays
  definable, usable and improvable with the fork down. Only adapter training and
  trained inference require it.
- **Tenancy is unresolved.** Numbatch's library is `organisation_id`-scoped
  (upstream ADR-0003) while redline inherits Wayfinder identity
  ([ADR-0006](./0006-inherit-wayfinder-auth-roles.adr.md)). The mapping needs its
  own decision before a lens is shared between users.
- Lens state is split across two stores (redline's lens rows, Numbatch's
  library), so a full picture requires both. Accepted as the cost of not syncing.

## Alternatives considered

- **Mirror the library into `redline_` tables, pushing to Numbatch on
  bootstrap.** Rejected: it introduces a two-way sync and a duplicate source of
  truth, and rebuilds machinery Numbatch already provides correctly. Its one real
  advantage — the lens remaining queryable with the fork down — is largely
  delivered anyway by ADR-0008's first pass.
- **Keep the flattened, evaluation-scoped model.** Rejected: it is the defect
  this ADR exists to correct. A lens that cannot outlive its evaluation cannot
  compound, and compounding is the value proposition.

## Enforcement

- Thread 17 makes `Lens`/`Topic` durable and evaluation-independent; its exit
  test requires a lens to construct with **no `evaluationId`**.
- Thread 29 persists the lens and its bindings in `redline_`-prefixed tables
  (validate.sh check #7); no `redline_` table stores Numbatch samples.
- Thread 30's exit test — a lens saved in one evaluation classifying another,
  with its boundary decisions still biting — is the proof the tier is real.
- Thread 33 pushes decisions as samples; re-push must be a no-op via upstream
  dedupe.
