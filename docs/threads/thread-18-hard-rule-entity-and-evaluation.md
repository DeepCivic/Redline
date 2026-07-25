# Thread 18 — `HardRule` entity + pure evaluation

**Status:** ✅ Complete · **Date:** 2026-07-25 · **Version intent:** MINOR (pre-1.0; adds a new entity and a pure function, changes nothing existing)

Design entry: [`docs/comprehension-lens-design.md` §6 · Track L](../comprehension-lens-design.md)
· locks [ADR-0011](../adr/0011-hard-rule-precedence-is-specificity-then-declaration-order.adr.md) (discovered)
· unblocks Thread 21 (hard-rule pre-pass)

## Goal

Build the lens's deterministic first stage: a rule that assigns a document to a
topic by pattern, before any model runs (design doc §3, "hard rules → assigned").

**Exit test:** rule-match invariants covered incl. precedence and no-match; pure,
no I/O.

## What was built

All of it in `packages/redline-domain` — one package, zero dependencies, pure.

### New — `entities/hard-rule.ts`

| Symbol | Contents |
|---|---|
| `HardRule` (`id`, `pattern`, `topicId`) + `makeHardRule` | The rule. `topicId` is a plain reference, not a `Topic` — the domain evaluates a rule without holding the lens. Trims all three; collapses runs of `*`; rejects a blank field and a pattern that pins no characters. |
| `matchesHardRule(rule, subject)` | Whole-subject, case-insensitive glob. `*` is the only metacharacter; every other character is literal (regex metacharacters included). Blank subjects never match. |
| `hardRuleSpecificity(rule)` | Characters the pattern pins — the precedence order of ADR-0011. |
| `HardRuleSet` (`rules`) + `makeHardRuleSet` | The rules a lens carries, in declaration order (load-bearing as the tie-break). Unique by `id` and by pattern. **Empty is legitimate** — the first pass runs with no hard rules at all (ADR-0008). |

### New — `entities/hard-rule-evaluation.ts`

| Symbol | Contents |
|---|---|
| `HardRuleCandidate` (`documentId`, `subjects`) | What a document offers a rule: its identifier tokens, extracted by the caller. Hard rules match identifiers, never prose. |
| `HardRuleOutcome` = `HardRuleClaim` \| `HardRuleGap` | `claimed` carries `topicId`, `ruleId` and the `matchedSubject`; `unclaimed` carries only the document. |
| `evaluateHardRules({ ruleSet, candidate })` | Total and pure. Weighs every rule against every subject, then reduces to the winner: highest specificity, ties to the earlier rule. No `Result` — there is no error path. |

The two files are separate because they answer different questions: `hard-rule.ts`
is *what a rule is and whether it matches*; `hard-rule-evaluation.ts` is *which
rule wins*. Thread 21 imports the second and never re-implements it.

### Modified — `src/index.ts`

Re-exports both modules under a "Hard rules (Thread 18)" heading.

### Deliberately not touched — `entities/lens.ts`

A rule set is **not** attached to `Lens` in this thread. §10 records Thread 18 as
having no dependency on Thread 17, and the exit test does not reach the lens; the
attachment belongs with lens persistence (Thread 29), where the rules have
somewhere to live. `HardRule.topicId` is the seam that will carry it.

## Design decisions

Recorded as [ADR-0011](../adr/0011-hard-rule-precedence-is-specificity-then-declaration-order.adr.md),
a discovered decision — the thread's scope named "precedence when two rules hit"
without settling it, and writing the evaluation forced the answer.

- **Specificity, then declaration order.** `SEC-CRYPTO-*` beats `SEC-*` whichever
  order they were declared in; a wildcard-free pattern always wins because it
  pins the whole subject. A tie (`SEC-*` vs `*-014`) falls to the earlier rule,
  so the outcome is deterministic rather than iteration-order-dependent.
- **No match is an outcome, not a `DomainError`.** Unclaimed is the normal case —
  the document falls through to retrieval. This is D10 ("a per-document gap is
  skipped; only genuine misuse raises") made concrete for the first time in the
  domain.
- **Duplicate patterns are the misuse that does error.** Two rules with the same
  pattern can never be separated by precedence, so one is unreachable.
- **`*` alone is rejected.** A rule claiming every document silences the rest of
  the lens.
- **Rules match identifier subjects the caller supplies, not document text.** A
  rule that read prose would be a classifier, and this stage exists precisely to
  be the thing that is not one.

## Exit-test evidence

The workspace still cannot be installed as-is in this container: `vendor/wayfinder`
is absent, so `@rbrasier/domain@workspace:*` does not resolve and `pnpm install`
fails at the root — checks 1–3 of `./validate.sh` fail identically on the
unmodified tree (verified before any code was written, exactly as in Thread 17).
Unlike Thread 17's container this host *does* have Node 22 + pnpm, so the suite
ran natively against an isolated copy of `packages/redline-domain` with the one
Wayfinder-dependent file (`src/wayfinder-spike.test.ts`, 3 tests) excluded:

```
vitest run → Test Files 11 passed (11) · Tests 95 passed (95)
  entities/hard-rule.test.ts                 (22)  ← new
  entities/evaluation-structure.test.ts      (13)
  entities/hard-rule-evaluation.test.ts      (11)  ← new
  entities/lens.test.ts                      (10)
  entities/requirement.test.ts                (9)
  entities/procurement-response.test.ts       (9)
  entities/lens-projection.test.ts            (7)
  entities/topic.test.ts                      (5)
  entities/evaluation.test.ts                 (5)
  ports/ports.test.ts                         (3)
  ports/language-model.test.ts                (1)

tsc --noEmit  → clean
eslint        → 29 files linted, 0 problems
```

33 new tests, and the 62 from Thread 17 still green. Against the exit test,
specifically:

| Exit criterion | Covered by |
|---|---|
| rule-match invariants | `hard-rule.test.ts` (22) — blank id/topic/pattern, a pattern that pins nothing, wildcard suffix/infix/empty-run, anchoring, case-insensitivity, regex metacharacters as literals, subject trimming, blank subjects, duplicate ids, duplicate patterns, empty set, defensive copy |
| precedence | `hard-rule-evaluation.test.ts` → more specific wins; wins in **either** declaration order; exact beats wildcard; equal specificity falls to declaration order; the winner is weighed across **all** the document's subjects |
| no-match | `hard-rule-evaluation.test.ts` → no matching rule, empty rule set, and no subjects each yield `{ kind: "unclaimed" }` — never an error |
| pure, no I/O | Nothing imported beyond `./hard-rule`; purity check #4 PASS; a test asserts repeated evaluation is identical and mutates neither input |

`./validate.sh` on the real tree: **checks 4–11 PASS** (8 passed, including #4
domain purity, #8 no focused tests, #9 file size, and both Python suites);
checks 1–3 fail for the environment reason above, exactly as they do on `main`.

## Known limitations / follow-ups

1. **`validate.sh` still cannot run green in this container.** Unchanged from
   Thread 17 follow-up 1, and now slightly sharper: this host has Node, so the
   *only* thing standing between the workspace and a green run is the absent
   `vendor/wayfinder` needed by two spike tests. Worth its own thread.
2. **Rules are not attached to a `Lens`.** Deliberate (above); Thread 29.
3. **No explicit priority field.** ADR-0011 accepts specificity as the only
   precedence axis; an optional `priority` ahead of it is additive if real use
   demands it.
4. **Subjects are the caller's problem.** Nothing in the domain says how a
   document yields identifier tokens; Thread 21 decides that, and it will want a
   fixture corpus to justify the choice.
5. **Matching compiles a `RegExp` per rule per call.** Irrelevant at 10 rules,
   worth memoising if a rule set ever meets a large corpus in a hot loop.
6. **Design doc §9 open question #1 was labelled "(Thread 18)"** — a stale
   reference from an earlier numbering; the vector wire format is Thread 19's,
   as §6 and §10 both already said. Corrected in this thread's commit.
