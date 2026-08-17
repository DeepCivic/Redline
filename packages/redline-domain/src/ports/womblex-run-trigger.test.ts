import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type { IWomblexRunTrigger } from "./womblex-run-trigger";

class StubWomblexRunTrigger implements IWomblexRunTrigger {
  async trigger(): Promise<Result<{ readonly runId: string }>> {
    return ok({ runId: "run-20260817T021531Z" });
  }
}

describe("port conformance (in-memory fake)", () => {
  it("triggers a run over a corpus's staged documents", async () => {
    const trigger: IWomblexRunTrigger = new StubWomblexRunTrigger();

    const result = await trigger.trigger("corpus-1", ["hashA"]);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.runId).toBe("run-20260817T021531Z");
  });
});
