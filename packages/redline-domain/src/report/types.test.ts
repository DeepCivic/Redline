import { describe, it, expect } from "vitest";
import type { ReportColumn, ReportRow, ReportRun, Evidence, FieldValue } from "./types";

describe("report data model (§2)", () => {
  it("a verified value carries evidence citing the chunk it was copied from", () => {
    const column: ReportColumn = {
      columnId: "penalty-amount",
      name: "Penalty amount",
      semanticDescription: "The maximum penalty stated for the offence",
      constraint: { kind: "financial", currency: "AUD" },
    };
    const documentId = "c5c98a362f5f91931e96c128ce00adb875f4a084cd6cc1edd0738b7fb00cef54";
    const evidence: Evidence = {
      documentId,
      chunkId: `${documentId}:2`,
      quotedText: "$10 000, in the case of an individual",
    };
    const value: FieldValue = {
      columnId: column.columnId,
      rawValue: "$10 000",
      normalisedValue: "10000.0000",
      status: "verified",
      evidence: [evidence],
      reason: null,
    };
    const row: ReportRow = { documentId, values: [value] };

    expect(row.values[0]?.status).toBe("verified");
    expect(row.values[0]?.evidence[0]?.chunkId).toBe(`${documentId}:2`);
  });

  it("a run tracks the corpus and definition it was started against", () => {
    const run: ReportRun = {
      runId: "run-1",
      corpusId: "corpus-1",
      definitionId: "def-1",
      documentIds: ["hashA"],
      status: "pending",
    };

    expect(run.status).toBe("pending");
  });
});
