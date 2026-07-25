# Thread 17 — `Topic` + `Lens` entities

**Status:** ✅ Complete · **Date:** 2026-07-25 · **Version intent:** MINOR (pre-1.0; adds a new domain tier, changes nothing existing)

Design entry: [`docs/comprehension-lens-design.md` §6 · Track L](../comprehension-lens-design.md)
· enacts [ADR-0009](../adr/0009-numbatch-library-is-system-of-record.adr.md)
· locks [ADR-0010](../adr/0010-topic-identity-carries-into-the-requirement-projection.adr.md) (discovered)
· unblocks Thread 18 (`HardRule`) and Thread 29 (lens persistence)

## Goal

Restore the **library tier** the domain had flattened away (design doc Finding 1):
a `Topic` and a `Lens` that are durable and evaluation-independent, with
`RequirementSet` demoted to a projection of a lens bound to an evaluation.

**Exit test:** lens/topic invariants covered; a lens constructs with no
`evaluationId`; `RequirementSet` still satisfies its ≤10 cap; purity check #4
green.

## What was built

All of it in `packages/redline-domain` — one package, zero dependencies, pure.

### New — `entities/topic.ts`

| Symbol | Contents |
|---|---|
| `Topic` (`id`, `name`, `definition`) + `makeTopic` | The durable criterion: a name plus the prose definition retrieval matches chunk vectors against. Trims all three; each must be non-blank. **No evaluation binding** — a topic outlives any evaluation that uses it. |

The Numbatch `topic_id` binding is deliberately *not* a field here. Per ADR-0009
Numbatch's library is the system of record and redline holds references; the
binding is its own record, added with persistence in Thread 29.

### New — `entities/lens.ts`

| Symbol | Contents |
|---|---|
| `Lens` (`id`, `name`, ordered `topics`) + `makeLens` | The durable asset. Constructs with **no `evaluationId`** — the ADR-0009 exit condition. Order-preserving, unique by topic `id`, and copies the caller's array. |
| `MIN_TOPICS_PER_LENS = 2` | Below two topics there is nothing to sort between, so the collision loop has no work (design doc §2, "2–10 topics"). |
| `MAX_TOPICS_PER_LENS = 10` | The same Numbatch per-profile ceiling as `MAX_REQUIREMENTS_PER_SET`, restated rather than imported (ADR-0010). |

### New — `entities/lens-projection.ts`

| Symbol | Contents |
|---|---|
| `projectRequirementSet({ lens, evaluationId })` | Binds a durable lens to one evaluation, producing a `RequirementSet`. Identity-preserving: a projected requirement's `id` **is** its topic's `id` (ADR-0010). Trims `evaluationId` and rejects a blank one. |

The projection is the only place the two tiers meet, and the dependency runs one
way: `topic.ts` and `lens.ts` import neither `requirement.ts` nor the projection.

### Modified — `src/index.ts`

Re-exports the three new modules under a "Comprehension lens (Thread 17)" heading.

### Unchanged — `entities/requirement.ts`

Not touched. `Requirement`, `RequirementSet` and `MAX_REQUIREMENTS_PER_SET` keep
their existing shape and invariants, so every caller from Threads 5/9/10 is
unaffected. ADR-0009 amended ADR-0004 on the *lifetime* of a `RequirementSet`,
not its structure, and this thread enacts that as a new tier above it rather
than a rewrite below it.

## Design decisions

- **Two types, one identity** — recorded as
  [ADR-0010](../adr/0010-topic-identity-carries-into-the-requirement-projection.adr.md),
  a discovered decision. `Topic` and `Requirement` are structurally identical
  today but have different lifetimes and diverge in Threads 18/27; the projection
  carries the topic's `id` through so `requirementId ↔ topic_id` stays one
  mapping and boundary decisions re-attach across corpora (Thread 30).
- **The ceiling is restated, not imported.** Importing `MAX_REQUIREMENTS_PER_SET`
  into `lens.ts` would make the durable tier depend on its own projection.
  Instead `lens-projection.test.ts` asserts the two constants agree, so a
  divergence that would make a valid lens unprojectable fails a test rather than
  surfacing at the adapter boundary.
- **A two-topic floor.** `RequirementSet` allows one requirement and still does;
  a *lens* requires two, because a single-topic lens sorts nothing and can raise
  no collision. Lens invariants are therefore strictly stronger than
  `RequirementSet`'s, which is what makes the projection total.
- **Blank `evaluationId` is rejected in the projection, not in
  `makeRequirementSet`.** Tightening the existing constructor would change
  behaviour for callers outside this thread's scope. See follow-up 3.

## Exit-test evidence

The workspace could not be installed as-is in this container: the
`vendor/wayfinder` submodule is absent and there is no podman, so
`@rbrasier/domain@workspace:*` does not resolve and `pnpm install` fails at the
root. This is a **pre-existing environment gap, not a regression** — checks 1–3
of `./validate.sh` fail identically on the unmodified tree (verified before any
code was written).

Thread 17 is domain-only and touches nothing Wayfinder-dependent, so the suite
was run against an isolated copy of `packages/redline-domain` with the one
Wayfinder-dependent file (`src/wayfinder-spike.test.ts`, 3 tests) excluded:

```
vitest run → Test Files 9 passed (9) · Tests 62 passed (62)
  entities/evaluation-structure.test.ts      (13)
  entities/lens.test.ts                      (10)  ← new
  entities/requirement.test.ts                (9)   unchanged, still green
  entities/procurement-response.test.ts       (9)
  entities/lens-projection.test.ts            (7)  ← new
  entities/topic.test.ts                      (5)  ← new
  entities/evaluation.test.ts                 (5)
  ports/ports.test.ts                         (3)
  ports/language-model.test.ts                (1)

tsc --noEmit  → clean
eslint src    → 24 files linted, 0 problems
```

22 new tests. Against the exit test, specifically:

| Exit criterion | Covered by |
|---|---|
| lens/topic invariants covered | `lens.test.ts` (10) + `topic.test.ts` (5) — blank id/name/definition, the 2-topic floor, the 10-topic ceiling, duplicate ids, order preservation, defensive copy |
| a lens constructs with no `evaluationId` | `lens.test.ts` → "constructs with no evaluationId — a lens is evaluation-independent": asserts `Object.keys` is exactly `["id","name","topics"]` and `"evaluationId" in lens === false` |
| `RequirementSet` still satisfies its ≤10 cap | `requirement.test.ts` unchanged and green (9), plus `lens-projection.test.ts` → "projects a full lens within the RequirementSet ceiling" and the constant-agreement test |
| purity check #4 green | `./validate.sh` check 4 — PASS |

`./validate.sh` on the real tree: **checks 4–11 PASS** (including #4, domain
purity, and #9, file size); checks 1–3 (typecheck/lint/test) fail for the
environment reason above, exactly as they do on `main`.

## Known limitations / follow-ups

1. **`validate.sh` cannot run green in this container.** It needs either the
   `vendor/wayfinder` submodule initialised or a podman runner with a sibling
   Wayfinder checkout. Worth a thread of its own: the two spike tests are the
   only Wayfinder-dependent code in the workspace, and the domain package
   declares `@rbrasier/domain` as a devDependency solely to serve one of them.
2. **No Numbatch binding on `Topic` yet.** `topic_id` / `profile_id` references
   arrive with persistence in Thread 29, per ADR-0009.
3. **`makeRequirementSet` still accepts a blank `evaluationId`.** Pre-existing;
   the projection guards it, but the constructor does not. Tighten when a thread
   is already touching that file.
4. **A lens carries no hard rules or boundary decisions yet.** `HardRule` is
   Thread 18, `BoundaryDecision` Thread 27; both attach to the `Lens` shape this
   thread establishes.
5. **Topic edits do not propagate to an existing `RequirementSet`.** The
   projection is a copy, so re-projection is how a lens change reaches an
   evaluation (ADR-0010, Consequences).
