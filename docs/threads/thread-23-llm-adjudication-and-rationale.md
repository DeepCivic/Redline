# Thread 23 — LLM adjudication + rationale

**Status:** ✅ Complete · **Date:** 2026-08-07 · **Version intent:** MINOR (pre-1.0; new domain port + new use-case, additive, no existing behaviour changed)

Design entry: [`docs/comprehension-lens-design.md` §3, §6 · Track L](../comprehension-lens-design.md)
· settles **open question #2** (the adjudication seam)
· the third leg of the first-pass classification path, after Thread 21's [hard-rule pre-pass](./thread-21-hard-rule-pre-pass.md) and Thread 22's [retrieval classification](./thread-22-retrieval-classification.md)
· rests on ADR-0008/D2 (interchangeable at the port) and ADR-0010/D11 (topic id = requirement id) — no new ADR

## Goal

Build the lens's LLM adjudication stage (design doc §3, "LLM adjudication →
clear match + one-sentence rationale"): run the model **only** on what retrieval
left genuinely unclear, ask it to choose among the contending topics, and emit
the one-sentence rationale the workflow promises. What retrieval settled cleanly,
and what a hard rule already claimed (Thread 21), never reach the model.

**Exit test:** adjudicated assignments carry a rationale; the seam is a port,
exercised with a fake.

## The adjudication seam — settling open question #2

Open question #2 asked whether adjudication is a second method on
`ILanguageModel` or a distinct port. **It is a distinct port, `IAdjudicator`.**

`ILanguageModel.summarise` is procurement-shaped — `{ vendorName, productName,
passages }` — and shape-coupled to the review grid's product summary (Thread 10).
Adjudication is a _lens_ concern with a different input (the candidate topics in
contention) and a different output (a chosen topic + a rationale). Overloading
`ILanguageModel` with a second method would couple two operations that have
nothing in common but "there is a model behind this." A distinct port honours the
composable-operations design (§3, D4): each operation is an independent function
with its own seam, exercised with its own fake.

## What was built

Two packages, one seam each, one commit — the use-case is the deliverable; the
port is the model seam it composes.

### New — `packages/redline-domain/src/ports/adjudicator.ts`

| Symbol                                                         | Contents                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdjudicationCandidate` (`topicId`, `name`, `definition`)      | One topic the document might belong to. The model chooses among exactly these — it never invents a topic.                                                                                                                                                                              |
| `AdjudicationRequest` (`documentId`, `passages`, `candidates`) | The document's passages (the material the model reads) and the topics in contention.                                                                                                                                                                                                   |
| `Adjudication` (`documentId`, `chosenTopicId`, `rationale`)    | The verdict: the chosen topic (one of the candidates) and the one-sentence rationale. `chosenTopicId` becomes a `RequirementClassification`'s `requirementId` upstream (ADR-0010), so the paths still interchange (D2); the rationale rides _alongside_, not inside, the shared shape. |
| `IAdjudicator.adjudicate(request)`                             | `Promise<Result<Adjudication>>`. No thrown exceptions cross the port; a model that cannot decide returns a `Result` error.                                                                                                                                                             |

A 2-test port-conformance suite (`adjudicator.test.ts`) pins the shape with an
in-memory fake — the same pattern `language-model.test.ts` and
`text-embedder.test.ts` use. The port is plain data over `Result`, so
`redline-domain` keeps its zero-dependency purity (check #4 green).

### New — `packages/redline-application/src/use-cases/adjudicate-unclear.ts`

| Symbol                                                                          | Contents                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdjudicateUnclear` (`{ adjudicator }`)                                         | The use-case. For each unclear document it validates there is a genuine choice, calls the port, checks the verdict names an offered candidate, and emits an `AdjudicatedClassification`. |
| `UnclearDocument` (`documentId`, `passages`, `candidates`, `sourceChunkId`)     | One document retrieval could not cleanly separate, with the passages to read, the topics in contention, and the chunk that surfaced the ambiguity (preserved as provenance).             |
| `AdjudicatedClassification` (`extends RequirementClassification` + `rationale`) | A classification row with the model's one-sentence rationale. Strip `rationale` and a downstream sees exactly the shared shape (D2).                                                     |
| `AdjudicateUnclearInput` (`request`, `unclear`)                                 | The `ClassificationRequest` context and the unclear subset (may be empty).                                                                                                               |
| `AdjudicateUnclearDependencies`                                                 | The one injected port.                                                                                                                                                                   |

### Modified — the two package `index.ts`

`redline-domain` re-exports the `adjudicator` port; `redline-application` exports
`AdjudicateUnclear` and its input/dependency/output types under a "first-pass
classification (Thread 23)" heading.

## Design decisions

No new ADR — the load-bearing decisions were settled upstream and this thread
consumes them. Choices worth recording:

- **Adjudication is a distinct port, not a second `ILanguageModel` method.** The
  answer to open question #2 (above).
- **The chosen topic's id is the `requirementId` directly.** Per ADR-0010 a
  topic's identity carries into the requirement it projects to — the same move
  the hard-rule pre-pass and retrieval make; no mapping table.
- **The rationale rides _alongside_ the shared shape, not inside it.**
  `AdjudicatedClassification` extends `RequirementClassification` with one extra
  field. A downstream that only knows the base shape is unaffected (D2); one that
  wants the rationale reads the extra field. The two classification paths still
  interchange at the port.
- **A settled unclear case is `confidence: 1`.** Adjudication is a _decision_,
  not a ranked score — once the model has chosen, the assignment is treated as
  certain, like a hard-rule claim. The ambiguity that _led_ here was retrieval's
  concern (Thread 24's buckets); the verdict itself is not hedged.
- **`sourceChunkId` is preserved from the unclear input.** The chunk retrieval
  ranked highest — the one that surfaced the ambiguity — is carried through, so
  the adjudicated row still names its provenance rather than nulling it.
- **The verdict must name an offered candidate.** The port _promises_ the model
  chooses among the candidates; the use-case _enforces_ it — a hallucinated topic
  is a `VALIDATION_FAILED`, not a classification. This is the consumer-side guard
  against a model inventing a topic id.
- **Fewer than two candidates is a caller error.** Adjudication is a choice;
  with one (or no) candidate there is nothing to adjudicate. The use-case refuses
  with `VALIDATION_FAILED` _before_ spending a model call, rather than passing a
  no-choice document silently through.
- **No orchestrator.** This is one independent leg of §3, composed by the caller,
  not chained to Thread 21 or Thread 22 (D4). The caller decides what is
  "unclear" — Thread 24's Clear/Ambiguous derivation is what will feed this in
  the wired container; here the unclear set is an input.

## Exit-test evidence

```
@redline/redline-domain:test      ✓ src/ports/adjudicator.test.ts (2 tests)
                                  Tests  101 passed (101)   [was 99; +2]
@redline/redline-application:test ✓ src/use-cases/adjudicate-unclear.test.ts (8 tests)
                                  Tests  41 passed (41)     [was 33; +8]
```

Against the stated exit criterion:

| Exit criterion                                | Covered by                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **adjudicated assignments carry a rationale** | `adjudicate-unclear.test.ts` "adjudicated assignments carry a rationale" — the row's `rationale` is the model's sentence; "emits the RequirementClassification shape plus a rationale (interchangeable)" pins the exact key set |
| **the seam is a port, exercised with a fake** | `adjudicator.test.ts` (port conformance) + every use-case test drives a `RecordingAdjudicator` fake; no model runtime is present                                                                                                |

Beyond the stated criterion:

| Property                             | Covered by                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| interchangeable shape (D2)           | "emits the RequirementClassification shape plus a rationale" — strip `rationale` and the key set is the shared shape     |
| topic id = requirement id (ADR-0010) | `requirementId` is the chosen `topicId` in every passing test                                                            |
| only the unclear reach the model     | "only adjudicates the documents the caller marked unclear" (the recording fake asserts exactly the unclear document ids) |
| nothing unclear → no model call      | "returns an empty result and never calls the model when nothing is unclear"                                              |
| per-document independence            | "adjudicates each unclear document independently"                                                                        |
| refuse a hallucinated topic          | "rejects a verdict that names a topic outside the offered candidates" (`VALIDATION_FAILED`)                              |
| refuse a no-choice document          | "rejects an unclear document offering fewer than two candidates" (`VALIDATION_FAILED`, zero model calls)                 |
| error propagation                    | "propagates an adjudicator failure unchanged"                                                                            |

Purity checks stay green: `redline-domain` (#4) links no dependency (the new port
is plain data over `Result`); `redline-application` (#5) imports only
`@redline/redline-domain`.

`./validate.sh` — **12/12 PASS, Failed: 0.**

## Known limitations / follow-ups

1. **The "unclear" set is the caller's input, not derived here.** This thread
   accepts `UnclearDocument`s ready-made. **Thread 24** (the ambiguity signal
   register + Clear/Ambiguous derivation) is what decides _which_ documents are
   unclear and _which_ topics contend; wiring pre-pass → retrieval → buckets →
   adjudication is the caller's job in the container (no orchestrator, D4).
2. **Passages are the caller's input too.** The use-case does not read chunks —
   the caller supplies the passages (e.g. the chunks retrieval ranked highest).
   Pulling those off the extraction reader belongs one layer up.
3. **No adapter yet.** This thread builds the port and the use-case; a concrete
   `IAdjudicator` over a real model runtime (and its captured-payload contract
   test) lands with the model-adapter work, the same posture retrieval's real
   embedder (Thread 22 limitation 4) holds. The seam is proven with a fake here.
4. **`confidence: 1` is a modelling choice, not a model score.** An adjudicated
   assignment is certain _by decision_. If a future model returns a graded
   confidence worth surfacing, it would ride on the `Adjudication` verdict — but
   the UI shows Clear/Ambiguous buckets, not scores (non-goal §8), so there is no
   consumer for it today.
5. **This is one leg of §3.** The output feeds the comprehension read models
   (Threads 24–25) and, for what stays ambiguous, the bounded collision surface
   (Threads 26–27) — each an independent function, composed by the caller.
