# ADR-0010 — A topic's identity carries into the requirement it projects to

- **Status**: Accepted
- **Date**: 2026-07-25

## Context

[ADR-0009](./0009-numbatch-library-is-system-of-record.adr.md) settled that a
lens is durable and evaluation-independent, and that a `RequirementSet` is a
**projection** of a lens bound to an evaluation. It did not say how the two tiers
relate at the level of identity, because the question only becomes concrete once
the projection is written.

Building Thread 17 forced it. `Topic { id, name, definition }` and
`Requirement { id, name, definition }` are structurally identical, so
`projectRequirementSet` has to answer two things the plan left open:

1. **Are they one type or two?** A single shared type removes an apparent
   duplication; two types keep the durable tier and the evaluation-scoped tier
   distinct.
2. **Does a projected requirement keep the topic's `id`, or get a fresh one
   scoped to the evaluation?** ADR-0004 kept `requirementId` as the adapter's
   translation key (`requirementId` ↔ Numbatch `topic_id`), and ADR-0009 left
   that ruling standing — but "`requirementId` is the key" is silent on whether
   that key is the topic's own.

The answer is load-bearing downstream. Boundary decisions are content-addressed
against topics (Thread 27–28) and must still bite when the lens is applied to
another corpus (Thread 30); the persisted binding is `requirementId ↔ topic_id`
(Thread 29); decisions are pushed back as topic samples (Thread 33). If a
projection minted new ids, every one of those seams would need a second mapping
to get back to the topic.

## Decision

**`Topic` and `Requirement` stay distinct types, and the projection is
identity-preserving: a projected requirement's `id` *is* its topic's `id`.**

- `projectRequirementSet({ lens, evaluationId })` copies each topic's `id`,
  `name` and `definition` onto a `Requirement` in the same order, and binds the
  set to the evaluation. Nothing is minted, nothing is renamed.
- The two types are kept separate because they have different lifetimes, not
  different shapes today. A `Topic` is durable and will accrete lens-tier
  structure the evaluation-scoped projection has no use for (hard rules in
  Thread 18, boundary decisions in Thread 27). Collapsing them now would have to
  be un-collapsed then.
- The dependency runs one way — `lens-projection.ts` imports both;
  `topic.ts` and `lens.ts` import neither `requirement.ts` nor each other's
  projection. The durable tier never depends on its own projection.
- `MAX_TOPICS_PER_LENS` restates `MAX_REQUIREMENTS_PER_SET` rather than
  importing it, for that reason. A test asserts the two agree, so a divergence
  that would make a valid lens unprojectable fails in the domain rather than at
  the adapter boundary.

## Consequences

**Positive**

- One mapping, not two. `requirementId ↔ topic_id` (Thread 29) stays the single
  translation, exactly as ADR-0004 intended, and the adapter needs no
  evaluation-scoped id table.
- Boundary decisions re-attach for free. A decision recorded against a topic
  applies to the requirement that topic becomes in *any* evaluation, which is the
  mechanism Thread 30's exit test depends on.
- The projection is total and cheap: lens invariants (2–10 topics, unique ids)
  are strictly stronger than `RequirementSet`'s (1–10, unique), so a valid lens
  always projects.

**Negative**

- Three fields are declared twice. That is real duplication, accepted knowingly
  as the cost of keeping the tiers independent; the alternative couples them at
  the moment they are about to diverge.
- Requirement ids are no longer evaluation-local, so they are only unique within
  a lens. Two lenses may legitimately carry the same topic id, and any future
  cross-lens query must qualify by lens id.
- The projection is a copy, so a topic edited after a `RequirementSet` was built
  does not propagate. Correct for an evaluation-scoped snapshot, but it means
  re-projection — not mutation — is how a lens change reaches an evaluation.

## Alternatives considered

- **One shared type (`Requirement = Topic`).** Rejected: it reads as
  deduplication but merges two tiers with different lifetimes, and Threads 18/27
  add topic-only structure that an evaluation-scoped requirement has no meaning
  for. The duplication it removes is three field declarations; the coupling it
  adds is architectural.
- **Mint evaluation-scoped requirement ids.** Rejected: it buys evaluation-local
  uniqueness, which nothing needs, and costs a second mapping on every seam that
  has to reach the topic — the binding, the corrections push, and the
  cross-corpus re-attachment that makes a lens compound.

## Enforcement

- `packages/redline-domain/src/entities/lens-projection.ts` is the only place the
  two tiers meet; purity check #4 keeps it dependency-free.
- `lens-projection.test.ts` asserts the topic id survives the projection, that
  the same lens projects into two evaluations independently, and that
  `MAX_TOPICS_PER_LENS === MAX_REQUIREMENTS_PER_SET`.
- Thread 29 persists `requirementId ↔ topic_id` as one binding; a second
  id-mapping table appearing there is the signal this ADR has been violated.
