import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import { makeEvaluation, withIntakeStage } from "./evaluation";

describe("makeEvaluation", () => {
  it("starts a new evaluation at the documents_uploaded stage", () => {
    const result = makeEvaluation({ id: "e1", name: "  Panel refresh 2026  " });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.name).toBe("Panel refresh 2026");
    expect(result.data.stage).toBe("documents_uploaded");
  });

  it("accepts an explicit starting stage", () => {
    const result = makeEvaluation({ id: "e1", name: "Panel", stage: "review" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.stage).toBe("review");
  });

  it("fails when the name is blank", () => {
    const result = makeEvaluation({ id: "e1", name: "   " });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("withIntakeStage", () => {
  it("advances an evaluation to the next adjacent stage", () => {
    const created = makeEvaluation({ id: "e1", name: "Panel" });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const advanced = withIntakeStage(created.data, "grouping");
    expect(isOk(advanced)).toBe(true);
    if (!isOk(advanced)) return;
    expect(advanced.data.stage).toBe("grouping");
  });

  it("rejects a skipped or backward stage transition", () => {
    const created = makeEvaluation({ id: "e1", name: "Panel" });
    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;

    const skipped = withIntakeStage(created.data, "review");
    expect(isErr(skipped)).toBe(true);
    if (!isErr(skipped)) return;
    expect(skipped.error.code).toBe("VALIDATION_FAILED");
  });
});
