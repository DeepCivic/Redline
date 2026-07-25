# Thread 21 — Hard-rule pre-pass

**Status:** ✅ Complete · **Date:** 2026-07-25 · **Version intent:** MINOR (pre-1.0; adds a new use-case, changes nothing existing)

Design entry: [`docs/comprehension-lens-design.md` §3, §6 · Track L](../comprehension-lens-design.md)
· composes Thread 18 (`evaluateHardRules`)
· first stage of the first-pass classification path (ADR-0008, D2)

## Goal

Build the lens's first classification stage: the deterministic hard-rule pre-pass
that runs *in front of* the model (design doc §3, "hard rules → assigned"). A
document a rule claims is resolved here and **never reaches the classifier**;
everything else falls through to Numbatch unchanged.

**Exit test:** rule-claimed documents produce classifications with the model port
unused (fake asserts zero calls).

## What was built

All of it in `packages/redline-application` — one package, over
`redline-domain` only, no new ports.

### New — `use-cases/classify-with-hard-rules.ts`

| Symbol | Contents |
|---|---|
| `ClassifyWithHardRules` (`{ classifier }`) | The use-case. Splits the request's documents into rule-claimed and unclaimed, synthesises a `RequirementClassification` for each claim, forwards **only** the unclaimed subset to `IProcurementClassifier`, and merges. |
| `ClassifyWithHardRulesInput` (`request`, `ruleSet`, `candidates`) | The `ClassificationRequest` context, the lens's `HardRuleSet` (Thread 18, may be empty), and the per-document identifier `HardRuleCandidate`s the caller extracted. |
| `ClassifyWithHardRulesDependencies` | The one injected port: the classifier the unclaimed remainder falls through to. |

The precedence and match logic are **not** re-implemented here — the use-case
composes the pure `evaluateHardRules` from Thread 18 and does only the routing.
This is the design doc's "Thread 21 imports the second and never re-implements
it" (thread-18 §"What was built") made literal.

### Modified — `src/index.ts`

Re-exports `ClassifyWithHardRules` and its two input/dependency types under a
"Comprehension lens — first-pass classification (Thread 21)" heading.

## Design decisions

No new ADR — the load-bearing decisions were already settled and this thread
consumes them:

- **A hard-rule match is a certainty, not a scored guess.** A claim emits
  `confidence: 1` and `sourceChunkId: null` — the match was on a caller-supplied
  identifier, not on any chunk of body text, so there is no source chunk to name.
  This keeps the two paths interchangeable at the port (D2): a downstream cannot
  tell a rule-claimed row from a model row *by its shape*, only by these values.
- **The claimed `topicId` is the `requirementId` directly.** ADR-0010 (D11): a
  topic's identity carries into the requirement it projects to, so the pre-pass
  needs no mapping table — it writes `outcome.topicId` into `requirementId`.
- **The classifier is skipped, not called empty, when everything is claimed.**
  "Claimed documents never reach the classifier" is made literally true by not
  invoking the port at all when the unclaimed set is empty — this is the exit
  test's central assertion (`calls` has length 0).
- **A document with no candidate is unclaimed, not an error.** If the request
  names a document the caller supplied no subjects for, it offers no subjects to
  match and falls through to the model. This is D10 ("a per-document gap is
  skipped") carried up from the domain into the application layer.
- **A classifier failure propagates unchanged.** The pre-pass adds no error
  path of its own — it only routes.

## Exit-test evidence

`./validate.sh` on the real tree: **12/12 PASS** (`Failed: 0`), verified both via
the package suite and the whole-workspace validate.

```
vitest run (redline-application) → Test Files 5 passed (5) · Tests 24 passed (24)
  use-cases/classify-with-hard-rules.test.ts   (8)  ← new
  use-cases/classify-and-extract.test.ts       (4)
  use-cases/assign-documents-to-groups.test.ts (4)
  use-cases/ingest-documents.test.ts           (3)
  use-cases/build-evaluation-table.test.ts     (5)
```

Against the exit test, specifically:

| Exit criterion | Covered by |
|---|---|
| rule-claimed documents produce classifications | "resolves rule-claimed documents without ever calling the classifier" — asserts the exact `RequirementClassification` for a `SEC-*` claim |
| model port unused (fake asserts zero calls) | same test + "skips the classifier entirely when every document is claimed" — both assert `classifier.calls` has length 0 |
| unclaimed documents still reach the model | "forwards only the unclaimed documents to the classifier" (one call, only `doc-prose`); "calls the classifier with the whole group when no rule claims anything"; "treats a document with no candidate as unclaimed and forwards it" |
| the two paths merge and interchange | "forwards only the unclaimed documents" — result contains both the deterministic claim and the model roll-up in the same shape; "orders the result claimed-first, then the model rows" pins the merge order |
| candidates are scoped to the request | "ignores a candidate for a document not named in the request" |
| errors route, not swallow | "propagates a classifier failure unchanged" |

The `RecordingClassifier` fake records every `classifyResponseGroup` call, so
"zero calls" and "called with exactly the unclaimed subset" are both direct
assertions rather than inferred.

Check 5 (redline-application imports only redline-domain and redline-shared)
stays green — the use-case imports nothing beyond `@redline/redline-domain`.

## Known limitations / follow-ups

1. **Subjects are still the caller's problem.** Thread 18 §"limitations" flagged
   that nothing in the domain says how a document yields identifier tokens; this
   thread accepts `HardRuleCandidate`s ready-made and does not decide extraction.
   The wiring that pulls identifiers off an ingested document belongs with the
   controller/container, not this pure use-case.
2. **The rule set is passed in, not read from a persisted lens.** Rules are not
   yet attached to a `Lens` (Thread 18 limitation 2; Thread 29). Until then the
   caller supplies the `HardRuleSet` directly.
3. **No response-group membership check.** The use-case trusts that
   `request.documentIds` and the candidates describe the same group; validating
   that the documents belong to the response group is the calling use-case's job.
4. **Duplicate `documentIds` are not de-duplicated.** The use-case iterates the
   request's document list as given, matching the sibling `ClassifyResponseGroup`
   (which also passes `documentIds` straight through). A repeated id would yield a
   repeated row or a repeated forward — a caller error, not one this stage masks.
   If a group can legitimately carry duplicates, dedup belongs one layer up where
   the group is assembled, not in the router.
5. **This is one leg of §3.** Retrieval (Thread 22) and LLM adjudication (Thread
   23) are the stages the unclaimed remainder flows into next; each is an
   independent function, composed by the caller, not chained here (no orchestrator,
   per D4).
