import { describe, it, expect } from "vitest";
import {
  AMBIGUITY_SIGNALS,
  implementedSignals,
  type AmbiguitySignal,
  type RankedCandidate,
} from "./ambiguity-signal";

// A document's ranked topic candidates — the scored input the signals read.
// The scores are the retrieval/classification confidences; they
// enter here and are consumed here. Nothing downstream of the derivation sees
// them (non-goal §8: no confidence scores in the UI).
const ranked = (...scores: readonly number[]): readonly RankedCandidate[] =>
  scores.map((score, index) => ({ topicId: `topic-${index}`, score }));

describe("the ambiguity signal register", () => {
  it("is a named, statused register in womblex's heuristics_disambiguation shape", () => {
    // Every entry carries a name, the signal it indicates, its implementing
    // symbol, and an implemented/not-implemented status — the four columns of
    // womblex's register. A not-implemented signal is *listed*, not omitted.
    for (const signal of AMBIGUITY_SIGNALS) {
      expect(signal.id).not.toBe("");
      expect(signal.signal).not.toBe("");
      expect(signal.status === "implemented" || signal.status === "not-implemented").toBe(true);
      if (signal.status === "implemented") {
        expect(signal.symbol).not.toBe("");
        expect(typeof signal.fires).toBe("function");
      } else {
        expect(signal.symbol).toBeUndefined();
        expect(signal).not.toHaveProperty("fires");
      }
    }
  });

  it("carries signal ids that are unique — the register is addressable by name", () => {
    const ids = AMBIGUITY_SIGNALS.map((signal) => signal.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lists at least one not-implemented signal — the space is documented, not just the wired part", () => {
    expect(AMBIGUITY_SIGNALS.some((signal) => signal.status === "not-implemented")).toBe(true);
  });

  it("exposes exactly the implemented signals through implementedSignals", () => {
    const wired = implementedSignals();
    expect(wired.every((signal) => signal.status === "implemented")).toBe(true);
    expect(wired.length).toBe(
      AMBIGUITY_SIGNALS.filter((signal) => signal.status === "implemented").length,
    );
  });
});

// The implemented signals, pinned individually. Each is a pure predicate over
// the ranked candidates; a not-implemented signal has no predicate to test.
const implemented = (id: string): Extract<AmbiguitySignal, { status: "implemented" }> => {
  const signal = AMBIGUITY_SIGNALS.find((each) => each.id === id);
  if (!signal || signal.status !== "implemented") {
    throw new Error(`expected an implemented signal '${id}'`);
  }
  return signal;
};

describe("no-clear-leader signal", () => {
  const signal = implemented("no-clear-leader");

  it("fires when nothing scored at all — there is nothing to be clear about", () => {
    expect(signal.fires(ranked())).toBe(true);
  });

  it("stays quiet when a single strong candidate leads", () => {
    expect(signal.fires(ranked(0.82))).toBe(false);
  });

  it("fires when the strongest candidate is below the confidence floor", () => {
    expect(signal.fires(ranked(0.2, 0.1))).toBe(true);
  });
});

describe("close-contenders signal", () => {
  const signal = implemented("close-contenders");

  it("fires when the top two candidates are within the margin", () => {
    expect(signal.fires(ranked(0.71, 0.69))).toBe(true);
  });

  it("stays quiet when the leader clears the runner-up by more than the margin", () => {
    expect(signal.fires(ranked(0.9, 0.4))).toBe(false);
  });

  it("stays quiet with a single candidate — there is no contender to be close to", () => {
    expect(signal.fires(ranked(0.71))).toBe(false);
  });

  it("stays quiet with no candidates — vacuously (no-clear-leader owns the empty case)", () => {
    expect(signal.fires(ranked())).toBe(false);
  });

  it("reads the two strongest, not declaration order", () => {
    // Given out of order: the two closest-at-the-top are 0.70 and 0.68.
    expect(signal.fires(ranked(0.1, 0.7, 0.68))).toBe(true);
  });
});

describe("signal purity", () => {
  it("never mutates the candidates it reads", () => {
    const candidates = ranked(0.71, 0.69);
    const snapshot = candidates.map((each) => ({ ...each }));
    for (const signal of implementedSignals()) signal.fires(candidates);
    expect(candidates).toEqual(snapshot);
  });
});
