import { describe, it, expect } from "vitest";
import { isErr, isOk } from "../result";
import {
  INTAKE_STAGES,
  canAdvanceIntakeStage,
  makeResponseGroup,
  makeVendor,
  nextIntakeStage,
} from "./evaluation-structure";

describe("makeVendor", () => {
  it("builds a solo vendor with no member vendors", () => {
    const result = makeVendor({ id: "v1", displayName: "  Acme  " });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.displayName).toBe("Acme");
    expect(result.data.isConsortium).toBe(false);
    expect(result.data.memberVendorIds).toEqual([]);
  });

  it("builds a consortium from two or more distinct member vendors", () => {
    const result = makeVendor({
      id: "consortium1",
      displayName: "Acme + Globex",
      isConsortium: true,
      memberVendorIds: ["v1", "v2", "v1"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.isConsortium).toBe(true);
    expect(result.data.memberVendorIds).toEqual(["v1", "v2"]);
  });

  it("fails when a consortium has fewer than two members", () => {
    const result = makeVendor({
      id: "consortium1",
      displayName: "Lonely consortium",
      isConsortium: true,
      memberVendorIds: ["v1"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when a non-consortium vendor declares member vendors", () => {
    const result = makeVendor({
      id: "v1",
      displayName: "Acme",
      isConsortium: false,
      memberVendorIds: ["v2"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the display name is blank", () => {
    const result = makeVendor({ id: "v1", displayName: "  " });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("makeResponseGroup", () => {
  it("builds a single-vendor response group", () => {
    const result = makeResponseGroup({
      id: "g1",
      evaluationId: "e1",
      vendorIds: ["v1"],
      label: "  Acme — Core Platform Bid  ",
      documentIds: ["hashA", "hashB", "hashA"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.label).toBe("Acme — Core Platform Bid");
    expect(result.data.isConsortiumResponse).toBe(false);
    expect(result.data.documentIds).toEqual(["hashA", "hashB"]);
  });

  it("flags a response group with more than one vendor as a consortium response", () => {
    const result = makeResponseGroup({
      id: "g1",
      evaluationId: "e1",
      vendorIds: ["v1", "v2"],
      label: "Consortium bid",
      documentIds: ["hashA"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.isConsortiumResponse).toBe(true);
  });

  it("fails when the group has no vendors", () => {
    const result = makeResponseGroup({
      id: "g1",
      evaluationId: "e1",
      vendorIds: [],
      label: "Orphan",
      documentIds: ["hashA"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the group has no documents", () => {
    const result = makeResponseGroup({
      id: "g1",
      evaluationId: "e1",
      vendorIds: ["v1"],
      label: "Empty",
      documentIds: [],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("IntakeStage transitions", () => {
  it("enumerates the intake stages in workflow order", () => {
    expect(INTAKE_STAGES).toEqual([
      "documents_uploaded",
      "grouping",
      "classifying",
      "review",
      "finalised",
    ]);
  });

  it("advances one stage forward at a time", () => {
    expect(nextIntakeStage("documents_uploaded")).toBe("grouping");
    expect(nextIntakeStage("review")).toBe("finalised");
  });

  it("has no stage beyond the terminal stage", () => {
    expect(nextIntakeStage("finalised")).toBeNull();
  });

  it("only permits forward adjacent transitions", () => {
    expect(canAdvanceIntakeStage("grouping", "classifying")).toBe(true);
    expect(canAdvanceIntakeStage("grouping", "review")).toBe(false);
    expect(canAdvanceIntakeStage("classifying", "grouping")).toBe(false);
    expect(canAdvanceIntakeStage("finalised", "finalised")).toBe(false);
  });
});
