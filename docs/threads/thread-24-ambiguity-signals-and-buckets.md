# Thread 24 — Ambiguity signal register + Clear/Ambiguous derivation

**Status:** ✅ Complete · **Date:** 2026-08-07 · **Version intent:** MINOR (pre-1.0; new pure domain read model + register, additive, no existing behaviour changed)

Design entry: [`docs/comprehension-lens-design.md` §3, §6, §8 · Track L](../comprehension-lens-design.md)
· the first of the two comprehension read models, before Thread 25's [Document Map](./thread-25-document-map-read-model.md)
· consumes what the first-pass classification path produces (Threads [21](./thread-21-hard-rule-pre-pass.md)/[22](./thread-22-retrieval-classification.md)/[23](./thread-23-llm-adjudication-and-rationale.md)) — the scores enter here and are consumed here
· rests on non-goal §8 ("No confidence scores in the UI. Replaced by Clear/Ambiguous buckets") — no new ADR

## Goal

Build the ambiguity signal register and the Clear/Ambiguous derivation the lens
uses to decide which documents sorted cleanly and which are genuine collisions
(design doc §3: "Signals are a named, statused register … the ambiguity signals
driving Clear/Ambiguous get the same treatment, rather than an opaque
threshold"). The register mirrors womblex's `docs/heuristics_disambiguation.md`
— each signal named, with its implementing symbol and an implemented /
not-implemented status. The derivation runs the *implemented* signals over a
document's ranked topic candidates and buckets it.

**Exit test:** bucketing covered per signal; no confidence value escapes to the
view model.

## The register — womblex's heuristics_disambiguation shape, applied

womblex's register is a four-column table — the heuristic's name, the **signal**
it indicates, its implementing **symbol** (the "Technical Reference"), and an
**✓ Implemented / Not implemented status** — and it deliberately *lists* the
not-yet-wired heuristics rather than omitting them, so the intended space is
documented, not just the built part.

`AMBIGUITY_SIGNALS` mirrors that exactly. A not-implemented signal is a
first-class entry carrying its name and the signal it will indicate, with **no
symbol and no predicate** — it passes through the derivation inert, the same
composable-fallback idiom §3 borrows from womblex ("a disabled stage passes
through unchanged"). Wiring a new signal is a status flip in the register, never
a change to the derivation.

## What was built

Two pure files in `redline-domain`, one commit — the register is the seam, the
derivation is the read model that runs it.

### New — `packages/redline-domain/src/entities/ambiguity-signal.ts`

| Symbol | Contents |
|---|---|
| `RankedCandidate` (`topicId`, `score`) | A document's scored topic candidate — the retrieval/classification confidence (Thread 22). Scores *enter* the register here and are consumed here. |
| `ImplementedSignal` (`id`, `signal`, `status: "implemented"`, `symbol`, `fires`) | A wired signal: its name, what it indicates, its implementing symbol, and a **pure predicate** over the ranked candidates. |
| `UnimplementedSignal` (`id`, `signal`, `status: "not-implemented"`) | A declared-but-inert signal — listed, no symbol, no predicate. |
| `AmbiguitySignal` | The discriminated union of the two. |
| `AMBIGUITY_SIGNALS` | The register. Two implemented (`no-clear-leader`, `close-contenders`) + two not-implemented (`sample-disagreement`, `cross-corpus-drift`). |
| `implementedSignals()` | The implemented subset — the signals the derivation actually runs. |
| `CONFIDENCE_FLOOR = 0.35`, `CONTENDER_MARGIN = 0.05` | Initial, **unmeasured** thresholds (open question #5). |

### New — `packages/redline-domain/src/entities/ambiguity-derivation.ts`

| Symbol | Contents |
|---|---|
| `ComprehensionInput` (`documentId`, `candidates`) | One document's ranked candidates (may be empty). |
| `ComprehensionBucket` (`"clear" \| "ambiguous"`) | The two buckets that replace confidence scores (non-goal §8). |
| `Comprehension` (`documentId`, `bucket`, `firedSignals`) | The derived read model — **exactly three fields**, none of them a number. `firedSignals` is the ids of the signals that fired, in register order. |
| `deriveComprehension(input)` | Pure, total: runs the implemented signals; Ambiguous iff at least one fires. |

### Modified — `packages/redline-domain/src/index.ts`

Re-exports both files under a "Comprehension (Thread 24)" heading.

## Design decisions

No new ADR — the load-bearing decision (buckets, not scores) is non-goal §8,
settled. Choices worth recording:

- **The register is womblex's `heuristics_disambiguation` genre, not a threshold
  constant.** Named, statused entries with their implementing symbol, and the
  not-implemented ones listed rather than omitted — so the derivation is
  auditable and the intended signal space is visible. This is what §3 asks for
  ("rather than an opaque threshold").
- **No confidence value escapes to the view model.** The load-bearing invariant
  of this thread. Scores enter as `RankedCandidate.score`, are read by the
  signals, and are gone: `Comprehension` carries a bucket and signal ids, no
  number. A test asserts the serialised output contains neither the score
  literals nor a `score`/`confidence` key, and that the key set is exactly
  `{ documentId, bucket, firedSignals }`.
- **Ambiguous iff *any* implemented signal fires.** There is no precedence and no
  first-wins — every implemented signal is evaluated and all that fire are
  reported (in register order, so the result is deterministic and the reason is
  legible). Register order is reporting order, not precedence.
- **A not-implemented signal passes through inert.** `deriveComprehension` runs
  only `implementedSignals()`; a declared-but-inert entry has no predicate to
  run. Wiring `sample-disagreement` or `cross-corpus-drift` is a status flip, not
  a derivation change — those two need signal this tier cannot read yet (accrued
  samples, cross-corpus history), which the overlay (Threads 33–34) and
  portability (Thread 30) supply.
- **Two implemented signals to start.** `no-clear-leader` (nothing scored, or the
  leader is below the floor) and `close-contenders` (top two within the margin).
  Between them they cover the two ways a first pass fails to sort cleanly: no
  confident answer, or two equally confident answers.
- **Thresholds are unmeasured.** `CONFIDENCE_FLOOR` and `CONTENDER_MARGIN` are
  initial values, not tuned ones (open question #5 — no corpus measured yet).
  They live as named constants in the register so tuning is a one-line change
  with a clear provenance.
- **`no-clear-leader` owns the empty case; `close-contenders` is vacuously
  quiet.** A document nothing scored is Ambiguous via `no-clear-leader`;
  `close-contenders` needs two candidates and stays quiet below that, so the two
  signals compose without double-owning the empty input.
- **Pure and total, one leg of §3.** No clock, store or model; every input yields
  a bucket. Called by whoever assembled the candidates — no orchestrator (D4).
  The Ambiguous bucket is precisely what feeds Thread 23's adjudicator "unclear"
  set and the bounded collision surface (Threads 26–27).

## Exit-test evidence

```
@redline/redline-domain:test  ✓ src/entities/ambiguity-signal.test.ts     (13 tests)
                              ✓ src/entities/ambiguity-derivation.test.ts  (9 tests)
                              Tests  123 passed (123)   [was 101; +22]
```

Against the stated exit criterion:

| Exit criterion | Covered by |
|---|---|
| **bucketing covered per signal** | `ambiguity-signal.test.ts` pins each implemented signal's predicate individually (`no-clear-leader`: empty / strong / weak; `close-contenders`: within-margin / clear-of-margin / single / empty / out-of-order); `ambiguity-derivation.test.ts` pins the bucket each produces and that all fired signals are reported |
| **no confidence value escapes to the view model** | `ambiguity-derivation.test.ts` "lets no confidence value escape" — the serialised `Comprehension` contains no score literal, no `score`/`confidence` key, and its key set is exactly `{ documentId, bucket, firedSignals }` |

Beyond the stated criterion:

| Property | Covered by |
|---|---|
| register is womblex's four-column shape | "is a named, statused register in womblex's heuristics_disambiguation shape" (every entry has name/signal/status; implemented carry symbol+`fires`, not-implemented carry neither) |
| not-implemented signals are listed, not omitted | "lists at least one not-implemented signal" |
| register is addressable by name | "carries signal ids that are unique" |
| only implemented signals run | "exposes exactly the implemented signals through implementedSignals" |
| every fired signal reported, in register order | "reports every signal that fired, not just the first" + "reports fired signals in register order" |
| purity | "is pure — repeated derivation returns the same result and mutates no input"; "never mutates the candidates it reads" |

Purity check #4 stays green: `redline-domain` links no dependency — both new
files import only sibling modules. `./validate.sh` — **12/12 PASS, Failed: 0.**

## Known limitations / follow-ups

1. **Thresholds are unmeasured (open question #5).** `CONFIDENCE_FLOOR` and
   `CONTENDER_MARGIN` are initial guesses. They will need tuning against a real
   corpus; the register makes that a one-line change.
2. **Two signals are declared but not wired.** `sample-disagreement` and
   `cross-corpus-drift` are listed to document the intended space (womblex's
   posture), but need signal this tier cannot read yet — accrued boundary
   decisions (Threads 33–34) and cross-corpus history (Thread 30). Wiring each is
   a status flip.
3. **The derivation does not assemble the candidates.** It reads
   `RankedCandidate[]` ready-made. Pulling the ranked topics off retrieval
   (Thread 22) and handing the Ambiguous set to the adjudicator (Thread 23) is
   the caller's job in the wired container (no orchestrator, D4).
4. **A single leader below the floor is Ambiguous, not a weak Clear.** By design:
   an uncontested but weak match is a collision the user should see, not a silent
   assignment. If measurement shows this over-flags, the floor is the dial.
