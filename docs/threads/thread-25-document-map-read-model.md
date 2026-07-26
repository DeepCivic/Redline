# Thread 25 — Document Map read model

**Status:** ✅ Complete · **Date:** 2026-08-07 · **Version intent:** MINOR (pre-1.0; new pure application read model, additive, no existing behaviour changed)

Design entry: [`docs/comprehension-lens-design.md` §2 step 2, §3, §6 · Track L](../comprehension-lens-design.md)
· the second of the two comprehension read models, after Thread 24's [Clear/Ambiguous derivation](./thread-24-ambiguity-signals-and-buckets.md)
· consumes what the first-pass classification path produces (Threads [21](./thread-21-hard-rule-pre-pass.md)/[22](./thread-22-retrieval-classification.md)/[23](./thread-23-llm-adjudication-and-rationale.md)) — which topic each document landed on — and the buckets [Thread 24](./thread-24-ambiguity-signals-and-buckets.md) derived
· reuses `computePivot`'s algorithm the way [Thread 13](./thread-13-pricing-pivots.md) did (reuse the algorithm, not the types); rests on non-goal §8 — no new ADR

## Goal

Build the **Document Map**: the derived, never-stored view of how the corpus
sorted across the lens's topics (design doc §2 step 2 "Map the corpus", §3). It
rolls the corpus classification up per topic — how many documents landed on each
topic and what share of the whole corpus that is — and reports the corpus-wide
Clear/Ambiguous split. Design doc §6 pins it as "Derived, never stored; reuses
`computePivot`."

**Exit test:** percentages match hand-computed totals on a fixture; recomputed,
not persisted.

## Reusing `computePivot` — the algorithm, not the types (Thread 13's precedent)

`computePivot` is Wayfinder's, exposed from `@rbrasier/domain`. That package is
reachable **only** from `redline-adapters` (CLAUDE.md architecture rule);
`redline-application`, where this read model lives, imports only
`@redline/redline-domain` and `@redline/redline-shared`. So — exactly as Thread
13 did for the pricing pivots — the map **reimplements `computePivot`'s
deterministic shape** over redline's own type rather than importing it:

- a **count** roll-up: distinct groups in first-appearance order, then ranked by
  **descending count with an alphabetical tiebreak** — `computePivot`'s
  `distinctValues` + `rankByTotal`, so the map and a pivot over the same data
  agree on order;
- percentages are the map's *own* concern (`computePivot` returns raw counts, not
  shares), computed over the grand total and hand-verifiable on a fixture.

The parity assertion against the **real** `computePivot` lives where Wayfinder is
reachable — the adapters' `wayfinder-contract.test.ts` — extended additively with
a count-measure fixture. That test runs under `REQUIRE_WAYFINDER=1` in CI, so the
map's ranking rule is checked against upstream, not just a frozen copy of it.

## What was built

One pure module in `redline-application`, one commit — plus the additive
count-measure entry in the adapters' Wayfinder drift check.

### New — `packages/redline-application/src/use-cases/build-document-map.ts`

| Symbol | Contents |
|---|---|
| `MappedDocument` (`documentId`, `topicId: string \| null`, `bucket`) | One classified document as the map reads it: the topic the classifier assigned (`null` when unassigned — nothing claimed it, or an unresolved collision) and the Thread 24 Clear/Ambiguous `bucket`. Carries **no score** (non-goal §8). |
| `DocumentMapEntry` (`topicId`, `count`, `percentage`) | One topic's slice: its document count and its share of the whole corpus. |
| `DocumentMap` | The derived view: `totalDocuments`, ranked `entries`, `assigned`/`unassigned` counts + share, and the corpus-wide `clear`/`ambiguous` counts + shares. |
| `buildDocumentMap(documents)` | Pure, total. Rolls the corpus up (`computePivot`'s count shape) and computes shares over the grand total; empty corpus yields an all-zero map with no division by zero. |

### Modified — `packages/redline-adapters/src/wayfinder/wayfinder-contract.ts` / `.test.ts`

- Widened `WayfinderPivotMeasure` to upstream's full `count | sum | avg` union
  (was `sum`-only) so the drift check exercises the whole signature.
- Added `WAYFINDER_COUNT_PIVOT_CONTRACT` — a count-measure fixture on a tie
  (`topic-c` 3; `topic-a`/`topic-b` 2 each), frozen to the order the real
  `computePivot` produces. The new test re-derives it from upstream, freezing the
  ranking rule the Document Map depends on.

### Modified — `packages/redline-application/src/index.ts`

Re-exports `buildDocumentMap` and its types under a "Document Map (Thread 25)"
heading.

## Design decisions

No new ADR — the load-bearing choices are settled precedent. Worth recording:

- **Reuse `computePivot`'s *algorithm*, not its *types* (Thread 13's precedent,
  reaffirmed).** `redline-application` cannot import `@rbrasier/domain`; the map
  reimplements the count-roll-up-and-rank shape over `MappedDocument`, and the
  parity assertion against the real `computePivot` lives in the one package that
  may reach Wayfinder (the adapters contract test). All the change stays inside
  Redline — womblex/Wayfinder remain read-only resources.
- **Derived, never stored (design doc §6).** `buildDocumentMap` is a pure
  function — no repository, no clock, no store. There is nothing to persist and
  nowhere to persist it; a test pins that repeated computation returns the same
  map and mutates no input. Recomputed on demand from the classification the
  first-pass path already produced.
- **No confidence value enters or escapes (non-goal §8).** A `MappedDocument`
  carries a `bucket`, not a score — consistent with Thread 24's `Comprehension`,
  which is its bucket source. A test asserts the serialised map contains no
  `confidence`/`score`. The map is counts and shares only.
- **A topic's share is of the *whole* corpus, not of the assigned subset.** So
  the per-topic shares plus the unassigned share sum to 100% and the map answers
  "what happened to the corpus", not "of what sorted, where". The unassigned
  (ambiguous / unclaimed) slice is a first-class number.
- **Assigned vs unassigned is orthogonal to Clear vs Ambiguous.** The map reports
  both splits. In the common case they coincide (an Ambiguous document is left
  unassigned), but the two are computed independently so the model does not
  presume the wiring — a caller may assign an Ambiguous document (e.g. a resolved
  collision) without the map miscounting.
- **Empty and all-ambiguous corpora are total.** Zero documents yields an
  all-zero map (shares guarded against divide-by-zero); an all-ambiguous corpus
  is 100% unassigned with no topic entries. No special-casing leaks to the
  caller.
- **Pure and total, one leg of §3.** Called by whoever assembled the
  classification and the buckets — no orchestrator (D4).

## Exit-test evidence

```
@redline/redline-application:test  ✓ src/use-cases/build-document-map.test.ts  (9 tests)
                                   Tests  50 passed (50)   [was 41; +9]

@redline/redline-adapters:test     ✓ src/wayfinder/wayfinder-contract.test.ts  (6 tests) [was 5; +1]
                                   Tests  70 passed (70)   (REQUIRE_WAYFINDER=1)
```

Against the stated exit criterion:

| Exit criterion | Covered by |
|---|---|
| **percentages match hand-computed totals on a fixture** | `build-document-map.test.ts` on a 10-document fixture: Security 5/10 → 50%, Pricing 3/10 → 30%, unassigned 2/10 → 20%; and the Clear/Ambiguous split 80% / 20% |
| **recomputed, not persisted** | `buildDocumentMap` is a pure function (no repository/clock/store injected); "is pure — repeated computation returns the same map and mutates no input" |

Beyond the stated criterion:

| Property | Covered by |
|---|---|
| ranking mirrors `computePivot` (desc count, alphabetical tiebreak) | `build-document-map.test.ts` "ranks topics by descending count, breaking ties alphabetically"; **parity against the real `computePivot`** frozen in the adapters' `wayfinder-contract.test.ts` count-measure fixture (re-derived from upstream under `REQUIRE_WAYFINDER=1`) |
| consumes the Thread 24 `Comprehension` shape | "accepts the Thread 24 Comprehension shape as its bucket source" |
| no confidence value enters or escapes (§8) | "carries no confidence value — the map is counts and shares only" |
| empty / all-ambiguous corpora are total | "returns an empty map for an empty corpus without dividing by zero"; "treats an all-ambiguous corpus as fully unassigned" |

Purity check #5 stays green: `redline-application` imports only
`@redline/redline-domain` (it reads the `ComprehensionBucket` type from there).
`./validate.sh` — **12/12 PASS, Failed: 0.**

## Known limitations / follow-ups

1. **The map does not assemble its input.** It reads `MappedDocument[]`
   ready-made — the join of "which topic the classifier assigned" (Threads
   21/22/23) to "which bucket Thread 24 derived" is the caller's job in the wired
   container (no orchestrator, D4). The wiring lands with the shell (Thread 35 /
   the collision surface, Thread 32).
2. **Percentages are unrounded.** Shares are exact (`part / whole * 100`); a
   fixture is chosen so every share is a round number. Display rounding is a
   view-model concern (Thread 32 / the shell), not the read model's.
3. **No cross-tab (topic × bucket) yet.** The map reports the two splits
   independently; a topic-by-bucket matrix (which topics attract the ambiguity)
   is a `computePivot` secondary-group shape available additively if a measured
   need appears.
