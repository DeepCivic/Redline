# Thread 2 — `proc-domain` core entities & ports

**Status:** ✅ Complete · **Date:** 2026-07-23 · **Version intent:** MINOR (pre-1.0; new public surface)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 0](../procurement-evaluation-plan.md)
· depends on [Thread 1](./thread-01-scaffold-and-spike.md)

## Goal

Fill `@procautomatr/proc-domain` with the procurement-evaluation **entities** and
**port interfaces** the rest of the plan builds against — pure TypeScript, zero
external dependencies, Result pattern at every boundary, tests-first.

**Exit test:** domain builds; entity invariants covered.

## What was built

### Entities (`src/entities/`)

| File | Contents |
|---|---|
| `procurement-requirement.ts` | `REQUIREMENT_NUMBERS` (fixed 1–6), `RequirementNumber`, `isRequirementNumber`, `ProcurementRequirement` + `makeProcurementRequirement` (trims title, de-dupes user-defined categories). |
| `evaluation-structure.ts` | `Vendor` + `makeVendor` (consortium ⇒ ≥2 distinct members; solo ⇒ no members); `ResponseGroup` + `makeResponseGroup` (≥1 vendor, ≥1 document; `isConsortiumResponse` when >1 vendor); `IntakeStage` (`INTAKE_STAGES`) + `nextIntakeStage` / `canAdvanceIntakeStage` (forward-adjacent only). |
| `procurement-response.ts` | `ProcurementResponse` (the central review-grid row) + `makeProcurementResponse`. Enforces requirement 1–6, non-blank vendor/product/summary, non-negative-or-null `estimateAud`, "estimate **or** description" costing, non-negative-integer `elementOrder`, non-blank `documentId`. Sub-types `ResponseCategorisation`, `ResponseCosting`, `ResponseSource`. |
| `evaluation.ts` | `Evaluation` aggregate root carrying the `IntakeStage`; `makeEvaluation` (defaults to `documents_uploaded`) + `withIntakeStage` (guards transitions via `canAdvanceIntakeStage`). |

### Ports (`src/ports/`)

| File | Interface | For thread |
|---|---|---|
| `procurement-extraction-reader.ts` | `IProcurementExtractionReader` (elements / chunks / table-cells with womblex provenance) | 4 |
| `procurement-classifier.ts` | `IProcurementClassifier` (fixed 1–6 + categories over a group's docs) | 5 |
| `financial-extractor.ts` | `IFinancialExtractor` (currency figure or description fallback → costing) | 7 |
| `evaluation-repository.ts` | `IEvaluationRepository` (persist/read the evaluation aggregate) | 9 |

All port methods return `Promise<Result<…>>` — no thrown exceptions cross the edge.

### Public surface

`src/index.ts` re-exports every entity and port alongside the Thread 1
`Result` / `DomainError` primitives.

## Design decisions

- **Smart constructors, not classes.** Entities are plain readonly interfaces;
  invariants live in `make*` factories returning `Result`. Keeps entities
  serialisable and free of behaviour, per CLAUDE.md ("plain TypeScript — no
  decorators").
- **`Evaluation` aggregate added.** §5 referenced `evaluationId` everywhere but
  named no aggregate root; the intake stage needed a home and Thread 9 needs
  something to persist. Introduced a minimal `Evaluation { id, name, stage }`.
  Not an ADR — a straightforward gap-fill within the plan's model.
- **Categorisation normalisation.** Blank `userDefinedCategory` / absent
  `solutionScope` collapse to an empty object so downstream pivots (Thread 13)
  never branch on `""` vs `undefined`.
- **Provenance shapes mirror womblex keys** (`documentId`=`source_hash`,
  `elementOrder`=`elem_order`, `chunkId`=`"{source_hash}:{chunk_index}"`) so the
  Thread 4 reader adapter is a thin mapping.

## Exit-test evidence

Run in `node:20-bookworm-slim` via Podman (`flatpak-spawn --host`), pnpm 9.12.0:

```
proc-domain test → Test Files 6 passed (6) · Tests 39 passed (39)
  entities/procurement-requirement.test.ts   (7)
  entities/evaluation-structure.test.ts      (13)
  entities/procurement-response.test.ts      (8)
  entities/evaluation.test.ts                (5)
  ports/ports.test.ts                        (3)
  wayfinder-spike.test.ts                     (3)   ← Thread 1, still green

./validate.sh → Passed: 9  Failed: 0  — All validations passed.
```

Check #4 (proc-domain purity — zero non-relative imports) passes: entities and
ports import only via relative paths.

## Known limitations / follow-ups

1. Port DTOs (`ExtractionElement`, `RequirementClassification`, etc.) are the
   domain's *minimum* need; adapters (Threads 4/5/7) may carry richer raw shapes
   internally and map down to these.
2. `ProcurementRequirement` is defined but not yet wired to a
   requirement-catalogue; Thread 5 (Numbatch profile) consumes it.
3. No zod schemas yet — `@procautomatr/proc-shared` stays a placeholder until a
   UI/adapter boundary needs runtime validation (Thread 4+).
