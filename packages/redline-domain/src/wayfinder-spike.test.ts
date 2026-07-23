import { describe, it, expect } from "vitest";

// --- Thread 1 exit test: Wayfinder consumption spike ---------------------------
//
// The plan's Thread 1 exit criterion is: "`pnpm build` green; test importing
// `typedDisplayCell` passes." This proves Strategy A works end to end — that a
// package in *this* workspace can import a typed helper from Wayfinder's
// unpublished `@rbrasier/domain` package (resolved via the shared pnpm workspace
// entry `vendor/wayfinder/packages/*`) and exercise it at runtime.
//
// If this import fails to resolve, the Wayfinder submodule has not been
// initialised (`git submodule update --init`) or the workspace glob is wrong.
import { typedDisplayCell, typedCellValue } from "@rbrasier/domain";

describe("Wayfinder consumption spike (Strategy A)", () => {
  it("imports and runs typedDisplayCell from @rbrasier/domain", () => {
    const cell = typedDisplayCell("currency", "1200.50");
    expect(cell.isNumeric).toBe(true);
    expect(cell.value).toBe(1200.5);
  });

  it("treats blank and non-numeric columns as text", () => {
    expect(typedDisplayCell("currency", "")).toEqual({ value: "", isNumeric: false });
    expect(typedDisplayCell("text", "Acme")).toEqual({ value: "Acme", isNumeric: false });
  });

  it("exposes typedCellValue as the unwrapped value", () => {
    expect(typedCellValue("currency", "80000")).toBe(80000);
    expect(typedCellValue("text", "component")).toBe("component");
  });
});
