import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type { IRunConfigOverride, RunConfigOverride } from "./run-config-override";

class StubRunConfigOverride implements IRunConfigOverride {
  private overrides: RunConfigOverride[] = [];

  async read(): Promise<Result<readonly RunConfigOverride[]>> {
    return ok(this.overrides);
  }

  async write(_corpusId: string, overrides: readonly RunConfigOverride[]): Promise<Result<void>> {
    this.overrides = [...overrides];
    return ok(undefined);
  }
}

describe("port conformance (in-memory fake)", () => {
  it("round-trips an override written for a corpus", async () => {
    const store: IRunConfigOverride = new StubRunConfigOverride();

    await store.write("corpus-1", [{ key: "extraction.ocr.engine", value: "mistral-ocr" }]);
    const result = await store.read("corpus-1");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0]?.key).toBe("extraction.ocr.engine");
  });
});
