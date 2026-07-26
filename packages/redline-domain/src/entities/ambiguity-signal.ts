// The ambiguity signal register — a named, statused register in the shape of
// womblex's `docs/heuristics_disambiguation.md` (design doc §3: "Signals are a
// named, statused register … the ambiguity signals driving Clear/Ambiguous get
// the same treatment, rather than an opaque threshold").
//
// womblex's register is a table of four columns — the heuristic's name, the
// signal it indicates, its implementing symbol (the "Technical Reference"), and
// an ✓ Implemented / Not implemented status — and it *lists* the not-yet-wired
// signals rather than omitting them, so the intended space is documented, not
// just the built part. This register mirrors that exactly: a not-implemented
// signal is a first-class entry with no predicate to run.
//
// Why a register and not a threshold constant: it makes the derivation
// (`ambiguity-derivation.ts`) auditable. A reader sees which signals decide
// Clear vs Ambiguous, which are declared-but-inert, and where each is
// implemented — the same legibility womblex's table gives its CV/NumPy
// heuristics.

// A document's ranked topic candidates — the scored input a signal reads. The
// scores are the retrieval/classification confidences (Thread 22). They enter
// the register here and are consumed here; the derivation emits only a bucket,
// so no score escapes to the view model (non-goal §8).
export interface RankedCandidate {
  readonly topicId: string;
  readonly score: number;
}

// The confidence a single leader must clear to be trusted as a Clear match.
// Below it, even an uncontested leader is too weak to assign silently.
// Unmeasured (open question #5) — an initial value, not a tuned one.
export const CONFIDENCE_FLOOR = 0.35;

// How close the runner-up may come to the leader before the two are treated as
// genuine contenders. Within this margin the document is Ambiguous — the
// collision the user resolves. Unmeasured (open question #5).
export const CONTENDER_MARGIN = 0.05;

// The two strongest scores, descending, without mutating the input. Fewer than
// two candidates yields `undefined` for the missing slot.
const topTwo = (
  candidates: readonly RankedCandidate[],
): readonly [number | undefined, number | undefined] => {
  const scores = candidates.map((candidate) => candidate.score).sort((a, b) => b - a);
  return [scores[0], scores[1]];
};

// A signal common to both statuses: the name, the thing it indicates, and its
// status. Mirrors womblex's "Heuristic" + "Signal" + "Status" columns.
interface SignalMeta {
  readonly id: string;
  readonly signal: string;
}

// An implemented signal carries its implementing symbol (womblex's "Technical
// Reference" column) and a pure predicate. `fires` reads the ranked candidates
// and returns whether this signal considers the document ambiguous.
export interface ImplementedSignal extends SignalMeta {
  readonly status: "implemented";
  readonly symbol: string;
  fires(candidates: readonly RankedCandidate[]): boolean;
}

// A declared-but-inert signal: listed so the intended space is documented, with
// no symbol and no predicate. It never runs in the derivation.
export interface UnimplementedSignal extends SignalMeta {
  readonly status: "not-implemented";
  readonly symbol?: undefined;
}

export type AmbiguitySignal = ImplementedSignal | UnimplementedSignal;

// The register. Order is load-bearing only as the reporting order of fired
// signals (`ambiguity-derivation.ts`), not as precedence — a document is
// Ambiguous if *any* implemented signal fires, so there is no first-wins.
export const AMBIGUITY_SIGNALS: readonly AmbiguitySignal[] = [
  {
    id: "no-clear-leader",
    signal: "no candidate is confident enough to assign",
    status: "implemented",
    symbol: "ambiguity-signal.ts:noClearLeader",
    fires: (candidates) => {
      const [leader] = topTwo(candidates);
      // Nothing scored, or the strongest is below the floor.
      return leader === undefined || leader < CONFIDENCE_FLOOR;
    },
  },
  {
    id: "close-contenders",
    signal: "two topics score within a margin of each other",
    status: "implemented",
    symbol: "ambiguity-signal.ts:closeContenders",
    fires: (candidates) => {
      const [leader, runnerUp] = topTwo(candidates);
      if (leader === undefined || runnerUp === undefined) return false;
      return leader - runnerUp <= CONTENDER_MARGIN;
    },
  },
  // Declared, not yet wired. Recorded so the space the lens intends to cover is
  // visible, exactly as womblex lists its not-implemented heuristics. Each needs
  // signal it cannot read yet (samples, cross-corpus history) — the overlay tier
  // (Threads 33–34) and portability (Thread 30) supply those.
  {
    id: "sample-disagreement",
    signal: "accrued boundary decisions disagree with this assignment",
    status: "not-implemented",
  },
  {
    id: "cross-corpus-drift",
    signal: "the same content was bucketed differently in another corpus",
    status: "not-implemented",
  },
];

// The implemented subset — the signals the derivation actually runs. A
// not-implemented signal passes through inert (design doc §3, the composable
// fallback idiom: "a disabled stage passes through unchanged").
export const implementedSignals = (): readonly ImplementedSignal[] =>
  AMBIGUITY_SIGNALS.filter((signal): signal is ImplementedSignal => signal.status === "implemented");
