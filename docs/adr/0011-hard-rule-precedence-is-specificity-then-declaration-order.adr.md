# ADR-0011 — Hard-rule precedence is specificity, then declaration order

- **Status**: Accepted
- **Date**: 2026-07-25

## Context

The comprehension lens's first stage is deterministic: hard rules assign a
document to a topic before any model runs (design doc §3, "hard rules → assigned
… (SEC-\*, CVE-\*)"), following womblex's precedent that register ingests
"produce Parquet directly and … bypass the NLP pipeline. This is by design."

Thread 18's scope names the question but not its answer: *"pattern → topic, match
semantics, precedence when two rules hit."* Writing the entity forced three
decisions the plan left open, and the exit test ("rule-match invariants covered
incl. precedence and no-match") makes precedence the load-bearing one.

Two rules hitting the same document is not an edge case — it is the normal way a
rule set grows. A specialist writes `SEC-*` on day one, then wants
`SEC-CRYPTO-*` to land somewhere else on day three. Both match `SEC-CRYPTO-004`,
and one of them must win, deterministically, or the stage stops being the
predictable pre-pass that justifies bypassing the model at all.

## Decision

**Precedence is pattern specificity first — the number of characters the pattern
pins — and declaration order second. The pattern language is literal text plus
`*`, matched whole-subject and case-insensitively.**

- **Specificity** = the count of non-wildcard characters in the pattern.
  `SEC-CRYPTO-*` (11) beats `SEC-*` (4). Among rules that *both matched the same
  subject*, more literal characters means more of that subject is constrained, so
  the more specific rule is the more deliberate one. A wildcard-free pattern that
  matches pins the whole subject, so an exact rule always wins.
- **Declaration order** breaks a specificity tie: the earlier rule in the set
  wins. `SEC-*` and `*-014` are both 4 characters and both claim `SEC-014`;
  nothing intrinsic separates them, so the rule set's own order does, and the
  outcome is total and deterministic rather than dependent on iteration order.
- **Two rules may not share a pattern.** `makeHardRuleSet` rejects it (case-
  insensitively, after collapsing wildcard runs): identical patterns can never be
  separated by precedence, so one is unreachable. That is an authoring error, and
  it is the one thing here that *is* an error — womblex's "only genuine misuse
  raises".
- **No match is not an error.** An unclaimed document is the normal case and
  falls through to retrieval, so `evaluateHardRules` returns an
  `unclaimed` outcome, not a `DomainError` (D10, "a per-document gap is
  skipped").
- **Matching is anchored and case-insensitive**, over identifier *subjects* the
  caller supplies — never the document body. A rule that read prose would be a
  classifier, and this stage exists to be the thing that is not one.
- **A pattern must pin at least one character.** `*` alone claims every document
  and would silence the rest of the lens; it is rejected at construction.

## Consequences

**Positive**

- Rule order in the UI stops being load-bearing for the common case. A specialist
  can add a narrower rule without reordering the set, which is the behaviour
  CSS selectors and HTTP routers have trained everyone to expect.
- The outcome is a total function of `(rule set, candidate)`: no clock, no store,
  no model. Thread 21's pre-pass can assert the model port was never called.
- The failure mode of an over-broad rule is bounded. `SEC-*` can be narrowed by
  adding a rule, not by editing the one that already works.

**Negative**

- Specificity is a proxy, not a semantic measure. `*-014` and `SEC-*` are equally
  specific by character count although a human might rank them differently; the
  order tie-break resolves it, but the resolution is conventional rather than
  principled.
- A rule set has no explicit priority field, so a specialist who wants an
  intentionally broad rule to beat a narrow one cannot express it. If that need
  turns up in real use, it is an additive change (an optional `priority` ahead of
  specificity), not a rewrite.
- Case-insensitive matching means `sec-*` and `SEC-*` are the same rule. Correct
  for procurement identifiers; wrong the day a lens needs case-sensitive codes.

## Alternatives considered

- **Explicit integer priority per rule.** Rejected for now: it makes every rule
  set carry a hand-maintained ordering that the author must keep consistent as
  rules accumulate, and the failure mode (two rules at the same priority) still
  needs the tie-break this ADR defines. Additive later if needed.
- **First match wins (pure declaration order).** Rejected: adding a narrower rule
  would require reordering the set, and a rule added at the bottom would silently
  never fire — the worst kind of failure for a deterministic stage.
- **Reject overlapping rules at construction.** Rejected: deciding whether two
  glob patterns can ever match the same subject is a language-inclusion problem,
  and `SEC-*` / `SEC-CRYPTO-*` overlapping is the *intended* way to author a rule
  set, not a mistake.
- **Full regular expressions as the pattern language.** Rejected: specificity
  would be undefinable, the rules would be unauthorable in a UI by a procurement
  specialist, and an untrusted pattern is a catastrophic-backtracking risk.

## Enforcement

- `packages/redline-domain/src/entities/hard-rule.ts` owns the pattern language
  and `hardRuleSpecificity`; `hard-rule-evaluation.ts` owns the precedence
  reduction. Both are pure, and purity check #4 keeps them dependency-free.
- `hard-rule-evaluation.test.ts` asserts specificity wins regardless of
  declaration order, that an exact pattern beats a wildcard, that a tie resolves
  on order, and that no match yields `unclaimed` rather than an error.
- Thread 21 consumes `HardRuleOutcome`; a pre-pass that re-implements precedence
  instead of calling `evaluateHardRules` is the signal this ADR has been
  violated.
