import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import {
  REQUIREMENT_NUMBERS,
  isRequirementNumber,
  makeProcurementRequirement,
  type RequirementNumber,
} from "./procurement-requirement";

describe("RequirementNumber", () => {
  it("enumerates the fixed 1–6 set in order", () => {
    expect(REQUIREMENT_NUMBERS).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("accepts the six fixed requirement numbers", () => {
    for (const candidate of [1, 2, 3, 4, 5, 6]) {
      expect(isRequirementNumber(candidate)).toBe(true);
    }
  });

  it("rejects numbers outside the fixed range", () => {
    for (const candidate of [0, 7, -1, 1.5, Number.NaN]) {
      expect(isRequirementNumber(candidate)).toBe(false);
    }
  });
});

describe("makeProcurementRequirement", () => {
  it("builds a requirement with a trimmed title and no categories", () => {
    const result = makeProcurementRequirement({
      number: 1,
      title: "  Whole-of-solution capability  ",
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.number).toBe(1);
    expect(result.data.title).toBe("Whole-of-solution capability");
    expect(result.data.userDefinedCategories).toEqual([]);
  });

  it("preserves and de-duplicates trimmed user-defined categories", () => {
    const result = makeProcurementRequirement({
      number: 6,
      title: "Category breakdown",
      userDefinedCategories: [" hardware ", "software", "hardware", "  "],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.userDefinedCategories).toEqual(["hardware", "software"]);
  });

  it("fails validation when the requirement number is out of range", () => {
    const result = makeProcurementRequirement({
      number: 9 as RequirementNumber,
      title: "Invalid",
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails validation when the title is blank", () => {
    const result = makeProcurementRequirement({ number: 2, title: "   " });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
