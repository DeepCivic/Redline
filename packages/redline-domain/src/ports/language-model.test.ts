import { describe, it, expect } from "vitest";
import { isOk, ok } from "../result";
import type { ILanguageModel, SummaryRequest } from "./language-model";

// The port is an interface, so the "test" is a conformance check: an in-memory
// fake satisfies the shape and returns a Result — no thrown exceptions cross it.
describe("ILanguageModel port", () => {
  it("is satisfied by an in-memory fake returning a Result", async () => {
    const model: ILanguageModel = {
      summarise: async (request: SummaryRequest) =>
        ok(`summary of ${request.passages.length} passages`),
    };

    const result = await model.summarise({
      vendorName: "Acme",
      productName: "Widget",
      passages: ["fast", "cheap"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toContain("2 passages");
  });
});
