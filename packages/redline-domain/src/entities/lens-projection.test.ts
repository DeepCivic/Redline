import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import { MAX_REQUIREMENTS_PER_SET } from "./requirement";
import { MAX_TOPICS_PER_LENS, makeLens, type Lens } from "./lens";
import { makeTopic, type Topic } from "./topic";
import { projectRequirementSet } from "./lens-projection";

const topic = (id: string, name: string): Topic => {
  const result = makeTopic({ id, name, definition: `${name} definition` });
  if (!isOk(result)) throw new Error("test fixture topic failed to build");
  return result.data;
};

const lensOf = (topics: readonly Topic[]): Lens => {
  const result = makeLens({ id: "lens-1", name: "Tender comprehension", topics });
  if (!isOk(result)) throw new Error("test fixture lens failed to build");
  return result.data;
};

const twoTopicLens = () => lensOf([topic("t1", "Security"), topic("t2", "Support")]);

describe("projectRequirementSet", () => {
  it("binds a lens to an evaluation, preserving topic order", () => {
    const result = projectRequirementSet({ lens: twoTopicLens(), evaluationId: "e1" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.evaluationId).toBe("e1");
    expect(result.data.requirements.map((requirement) => requirement.id)).toEqual(["t1", "t2"]);
  });

  it("carries the topic id through as the requirement id", () => {
    const result = projectRequirementSet({ lens: twoTopicLens(), evaluationId: "e1" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.requirements[0]).toEqual({
      id: "t1",
      name: "Security",
      definition: "Security definition",
    });
  });

  it("projects the same lens into two evaluations independently", () => {
    const lens = twoTopicLens();
    const first = projectRequirementSet({ lens, evaluationId: "e1" });
    const second = projectRequirementSet({ lens, evaluationId: "e2" });

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.data.evaluationId).toBe("e1");
    expect(second.data.evaluationId).toBe("e2");
    expect(first.data.requirements).toEqual(second.data.requirements);
  });

  it("trims the evaluation id", () => {
    const result = projectRequirementSet({ lens: twoTopicLens(), evaluationId: "  e1  " });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.evaluationId).toBe("e1");
  });

  it("fails when the evaluation id is blank", () => {
    const result = projectRequirementSet({ lens: twoTopicLens(), evaluationId: "   " });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("projects a full lens within the RequirementSet ceiling", () => {
    const topics = Array.from({ length: MAX_TOPICS_PER_LENS }, (_, index) =>
      topic(`t${index}`, `Topic ${index}`),
    );
    const result = projectRequirementSet({ lens: lensOf(topics), evaluationId: "e1" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.requirements).toHaveLength(MAX_REQUIREMENTS_PER_SET);
  });

  // The lens ceiling and the RequirementSet ceiling are the same Numbatch
  // profile limit restated in two tiers. If they ever diverge, a valid lens
  // becomes unprojectable — fail here rather than at the adapter boundary.
  it("holds the lens ceiling to the RequirementSet ceiling", () => {
    expect(MAX_TOPICS_PER_LENS).toBe(MAX_REQUIREMENTS_PER_SET);
  });
});
