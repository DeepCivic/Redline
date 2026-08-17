import { describe, it, expect } from "vitest";
import { ok, isOk, type Result } from "../result";
import type {
  IExtractionModel,
  ExtractionModelRequest,
  ExtractionColumnResult,
} from "./extraction-model";

// This fake exists to prove the extraction-model port is implementable and
// shaped as the per-document loop (step 6) needs. It is the port's spec.

class StubExtractionModel implements IExtractionModel {
  async extract(request: ExtractionModelRequest): Promise<Result<readonly ExtractionColumnResult[]>> {
    return ok(
      request.columns.map((column) => ({
        columnId: column.columnId,
        value: "$10 000",
        evidence: [{ documentId: request.documentId, chunkId: `${request.documentId}:2`, quotedText: "$10 000" }],
        absent: false,
        reason: null,
      })),
    );
  }
}

describe("port conformance (in-memory fake)", () => {
  it("returns one result per offered column, each citing evidence", async () => {
    const model: IExtractionModel = new StubExtractionModel();
    const request: ExtractionModelRequest = {
      corpusId: "corpus-1",
      runId: "run-1",
      documentId: "hashA",
      columns: [{ columnId: "penalty-amount", name: "Penalty amount", semanticDescription: "The stated penalty" }],
    };

    const result = await model.extract(request);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.columnId).toBe("penalty-amount");
    expect(result.data[0]?.evidence[0]?.chunkId).toBe("hashA:2");
  });
});
