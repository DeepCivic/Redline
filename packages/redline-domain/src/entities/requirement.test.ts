import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import {
  MAX_REQUIREMENTS_PER_SET,
  makeRequirement,
  makeRequirementSet,
  type Requirement,
} from "./requirement";

const validRequirementInput = (overrides: Partial<{ id: string; name: string; definition: string }> = {}) => ({
  id: "req-1",
  name: "  Data residency  ",
  definition: "  Data must be stored within Australia.  ",
  ...overrides,
});

describe("makeRequirement", () => {
  it("builds a requirement, trimming name and definition", () => {
    const result = makeRequirement(validRequirementInput());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.id).toBe("req-1");
    expect(result.data.name).toBe("Data residency");
    expect(result.data.definition).toBe("Data must be stored within Australia.");
  });

  it("fails when the id is blank", () => {
    const result = makeRequirement(validRequirementInput({ id: "   " }));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the name is blank", () => {
    const result = makeRequirement(validRequirementInput({ name: "  " }));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the definition is blank", () => {
    const result = makeRequirement(validRequirementInput({ definition: "   " }));

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("makeRequirementSet", () => {
  const requirement = (id: string, name: string): Requirement => {
    const result = makeRequirement({ id, name, definition: `${name} definition` });
    if (!isOk(result)) throw new Error("test fixture requirement failed to build");
    return result.data;
  };

  it("builds an ordered set preserving requirement order", () => {
    const result = makeRequirementSet({
      evaluationId: "e1",
      requirements: [requirement("r1", "First"), requirement("r2", "Second")],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.requirements.map((requirement) => requirement.id)).toEqual(["r1", "r2"]);
  });

  it("fails when the set is empty", () => {
    const result = makeRequirementSet({ evaluationId: "e1", requirements: [] });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when two requirements share an id", () => {
    const result = makeRequirementSet({
      evaluationId: "e1",
      requirements: [requirement("dup", "First"), requirement("dup", "Second")],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("accepts a full set at the Numbatch profile ceiling", () => {
    const requirements = Array.from({ length: MAX_REQUIREMENTS_PER_SET }, (_, index) =>
      requirement(`r${index}`, `Requirement ${index}`),
    );
    const result = makeRequirementSet({ evaluationId: "e1", requirements });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.requirements).toHaveLength(MAX_REQUIREMENTS_PER_SET);
  });

  it("fails when the set exceeds the Numbatch profile ceiling", () => {
    const requirements = Array.from({ length: MAX_REQUIREMENTS_PER_SET + 1 }, (_, index) =>
      requirement(`r${index}`, `Requirement ${index}`),
    );
    const result = makeRequirementSet({ evaluationId: "e1", requirements });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
