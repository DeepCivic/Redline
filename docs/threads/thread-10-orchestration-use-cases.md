# Thread 10 — Orchestration use-cases (`redline-application`)

**Status:** ✅ Complete · **Date:** 2026-07-31 · **Version intent:** MINOR (pre-1.0; new application surface — first use-cases)

Plan entry: [`docs/procurement-evaluation-plan.md` §7 · Track 3](../procurement-evaluation-plan.md)
· composes the ports from [Thread 2](./thread-02-redline-domain-entities-and-ports.md) / [Thread 2a](./thread-02a-generalise-requirements.md)
and the adapters from Threads [4](./thread-04-extraction-reader-adapter.md), [5](./thread-05-numbatch-integration.md),
[8](./thread-08-financial-extractor-adapter.md), [9](./thread-09-redline-persistence-layer.md)

## Goal

The orchestration layer: `IngestDocuments`, `AssignDocumentsToGroups`,
`ClassifyResponseGroup`, `ExtractFinancials`, `BuildEvaluationTable` — one
use-case per step of the specialist workflow (build plan §5), plus a one-paragraph
AI summary via an `ILanguageModel`-shaped port.

**Exit test:** use-case tests with mocked ports produce a full `ProcurementResponse[]`.

## What was built

### New domain port — `packages/redline-domain/src/ports/language-model.ts`

`ILanguageModel.summarise(SummaryRequest) → Promise<Result<string>>` — the
one-paragraph product-summary seam. `SummaryRequest` carries `vendorName`,
`productName`, and the vendor's matched `passages`. An adapter implements it over
whatever model runtime the deployment uses; the application layer only sees a
Result-returning port, so no AI SDK leaks past the boundary and the use-cases stay
unit-testable with a fake.

### Use-cases — `packages/redline-application/src/use-cases/`

| File | Use-case | Step (stage transition) |
|---|---|---|
| `ingest-documents.ts` | `IngestDocuments` | confirms every document reads back through `IProcurementExtractionReader`; persists the evaluation and advances `documents_uploaded → grouping`. Does **not** trigger womblex (that is the sidecar's job, Thread 3). |
| `assign-documents-to-groups.ts` | `AssignDocumentsToGroups` | persists vendors + response groups (consortium detection via `makeResponseGroup`); advances `grouping → classifying`. Rejects a group referencing a vendor not declared in the same call. |
| `classify-response-group.ts` | `ClassifyResponseGroup` | thin pass-through to `IProcurementClassifier` — names the step so a UI (Thread 11) can (re)run classification per group. |
| `extract-financials.ts` | `ExtractFinancials` | thin pass-through to `IFinancialExtractor`. |
| `build-evaluation-table.ts` | `BuildEvaluationTable` | **the composition** — see below; advances `classifying → review`. |

`BuildEvaluationTable` walks every response group and, per group, joins:
- the classifier's per-(document, requirement) roll-ups (`confidence` + `sourceChunkId`),
- the financial worker's per-(document, requirement) costing (keyed
  `documentId::requirementId`, so a figure attaches to the exact match),
- a one-paragraph AI summary over the document's matched passages (chunks read via
  the extraction reader),

into **one `ProcurementResponse` per (group, document, matched requirement)** — the
review grid's natural row (build plan §5) — via `makeProcurementResponse` (so every
domain invariant is enforced), persists them with `saveResponses`, and advances the
stage to `review`. Currency stays a real `number | null` end-to-end, consistent with
the Thread 8 adapter and the Thread 9 repository.

Also: `in-memory-evaluation-repository.test-support.ts` — a shared `IEvaluationRepository`
fake (excluded from the build; carries no `describe`, so importing it into several
suites does not re-run a test block); `src/index.ts` exports every use-case + its
dependency/input types; the domain index re-exports the new port.

## Design decisions

- **Use-cases inject ports, never construct adapters.** Every dependency is an
  interface from `redline-domain`; the app's container (Thread 11) wires the real
  adapters. This keeps `redline-application` framework/ORM/SDK-free (CLAUDE.md
  architecture rule, enforced by `validate.sh` check #5) and every use-case
  unit-testable with in-memory fakes — the exit test never touches Numbatch, a DB,
  or a model.
- **`ILanguageModel` is a domain port, implemented by an adapter later.** The
  summary is AI-shaped but the application layer must not import an AI SDK, so the
  seam lives in the domain and the concrete model adapter is a later thread's
  concern (or Thread 11 wiring).
- **`BuildEvaluationTable` composes the two thin use-cases** (`ClassifyResponseGroup`,
  `ExtractFinancials`) rather than calling the ports directly, so the named steps a
  UI drives and the table builder share one code path.
- **Stage transitions go through `withIntakeStage`.** Each use-case advances exactly
  one adjacent stage and only persists on success; a mid-flight failure (classifier
  down, a document with no extraction) returns the `DomainError` and leaves the
  evaluation untouched — no half-advanced state.
- **Costing fallbacks.** A matched requirement with a null-estimate extraction keeps
  the extractor's description; a match the extractor returned *nothing* for gets a
  `"no costing extracted yet"` fallback so `makeProcurementResponse`'s
  "estimate-or-description" invariant always holds.

## Exit-test evidence

Run via `./validate.sh` (Node 20 via Podman):

```
redline-application test → Test Files 4 passed (4) · Tests 16 passed (16)
  src/use-cases/ingest-documents.test.ts              (3)
  src/use-cases/assign-documents-to-groups.test.ts    (4)
  src/use-cases/classify-and-extract.test.ts          (4)   ← ClassifyResponseGroup + ExtractFinancials
  src/use-cases/build-evaluation-table.test.ts        (5)   ← the exit test

redline-domain test → 7 files, 43 passed (was 42; +1 ILanguageModel port)
./validate.sh → Passed: 11  Failed: 0  — All validations passed.
```

The exit test (`build-evaluation-table.test.ts`) seeds an evaluation at
`classifying` with one vendor + one group, wires in-memory classifier / financial
extractor / extraction reader / language-model fakes, and asserts the produced
`ProcurementResponse[]`: `vendorName "Acme"`, `requirementId "req-data-residency"`,
`confidence 0.86`, `costing.estimateAud 1500.5` (a **real number**),
`source.elementOrder 7`, `source.chunkId "doc-a:2"`, and a summary condensing the
matched passages — then confirms the row was persisted and the stage advanced to
`review`. Further cases cover the null-estimate fallback, the empty-extraction
fallback, a propagated classifier failure (nothing persisted, stage unchanged), and
the stage guard.

## Known limitations / follow-ups

1. **No concrete `ILanguageModel` adapter yet.** The port is defined and proven with
   a fake; the real summariser (over a model runtime) lands with the app wiring
   (Thread 11) or a dedicated adapter thread.
2. **One `productName` per evaluation.** `BuildEvaluationTable` takes a single
   product name; per-group / per-document product names are a Thread 11 concern once
   the control surface can capture them.
3. **Passages = all of a document's chunks.** The summary currently condenses every
   chunk of the matched document; narrowing to the requirement's matched chunks needs
   per-chunk provenance from the classifier roll-up (the port returns a single
   `sourceChunkId` today).
4. **No live end-to-end run** (no Numbatch/DB/model in this environment); the
   use-cases are proven against in-memory fakes, the same standalone posture as
   Threads 5–9. A real wiring smoke lands with Thread 11 or Thread 16.
