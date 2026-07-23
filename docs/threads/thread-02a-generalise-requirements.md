# Thread 2a — Generalise requirements: user-defined criteria (fix-forward)

**Status:** ✅ Complete · **Date:** 2026-07-26 · **Version intent:** MINOR (pre-1.0; reshapes an unreleased domain surface)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 0](../procurement-evaluation-plan.md)
· reverses part of [Thread 2](./thread-02-redline-domain-entities-and-ports.md)
· enacts [ADR-0004](../adr/0004-user-defined-requirements-not-fixed-1-6.adr.md)
· unblocks [Thread 5](./thread-05-numbatch-integration.md)

## Goal

Reshape `@redline/redline-domain` off the misread **fixed 1–6 requirement** model
onto **user-defined criteria**, mirroring Numbatch topics/profiles
([ADR-0004](../adr/0004-user-defined-requirements-not-fixed-1-6.adr.md)). Domain-only,
zero deps, tests-first.

**Exit test:** domain builds; `Requirement`/`RequirementSet` invariants covered
(incl. the ≤10 cap); no `RequirementNumber` remains; `./validate.sh` green incl.
purity check #4.

## What changed

### New entity — `entities/requirement.ts` (replaces `procurement-requirement.ts`)

| Symbol | Contents |
|---|---|
| `Requirement` (`id`, `name`, `definition`) + `makeRequirement` | A user-defined criterion. Trims all three fields; each must be non-blank. Maps to a Numbatch **topic** at the adapter boundary. |
| `RequirementSet` (`evaluationId`, ordered `requirements`) + `makeRequirementSet` | Mirrors a Numbatch **profile**: non-empty, unique by `id`, order-preserving, capped at `MAX_REQUIREMENTS_PER_SET`. |
| `MAX_REQUIREMENTS_PER_SET = 10` | Numbatch's per-profile ceiling (ADR-0004). |

`entities/procurement-requirement.ts` (and its test) — **deleted**. No
`REQUIREMENT_NUMBERS` / `RequirementNumber` / `isRequirementNumber` remain.

### Reshaped `entities/procurement-response.ts`

- `requirementNumber: RequirementNumber` → **`requirementId: string`** (trimmed, non-blank).
- Added **`confidence: number`** (0–1 roll-up confidence for the matched requirement) — the
  review-grid row now carries the classifier's confidence directly.
- Dropped `ResponseCategorisation` (`solutionScope` / `userDefinedCategory`) — it existed
  only to bolt user categories onto the fixed model; user-defined requirements subsume it.

### Reshaped ports

| Port | Change |
|---|---|
| `procurement-classifier.ts` — `RequirementClassification` | `requirementNumber` → `requirementId`; dropped `categorisation`. One row per matched requirement (roll-ups are multi-label). |
| `financial-extractor.ts` — `FinancialExtraction` | Added `requirementId` — figures key on **(documentId, requirementId)** per ADR-0004 (Threads 6–8). |

`src/index.ts` now re-exports `./entities/requirement` in place of the deleted module.

## Design decisions

- **Delete, don't deprecate.** Pre-1.0 and unreleased, so the fixed model is removed
  outright rather than kept alongside — no dead code (CLAUDE.md).
- **`confidence` promoted onto `ProcurementResponse`.** The classifier port already
  produced a confidence; surfacing it on the row keeps the grid a pure projection of
  the classification result and satisfies §5's "confidence + source chunk" per match.
- **Cap enforced in the entity, not the adapter.** `makeRequirementSet` rejects >10 so
  the Numbatch-profile ceiling is a domain invariant, independent of any adapter.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman):

```
redline-domain test → Test Files 6 passed (6) · Tests 42 passed (42)
  entities/requirement.test.ts               (10)  ← new
  entities/evaluation-structure.test.ts      (13)
  entities/procurement-response.test.ts      (10)  ← requirementId + confidence
  entities/evaluation.test.ts                (5)
  ports/ports.test.ts                        (3)
  wayfinder-spike.test.ts                    (3)

./validate.sh → Passed: 10  Failed: 0  — All validations passed.
```

Check #4 (redline-domain purity — zero non-relative imports) passes. `grep` confirms
no `RequirementNumber` / `REQUIREMENT_NUMBERS` remains in `src/`.

## Known limitations / follow-ups

1. `RequirementSet` is not yet persisted — Thread 9 adds the `redline_` tables; Thread 5
   bootstraps a Numbatch profile from a `RequirementSet` in memory.
2. The `NumbatchClassifier` adapter (Thread 5) is the single place `requirementId` ↔
   Numbatch `topic_id` is translated.
