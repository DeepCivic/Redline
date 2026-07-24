import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err, domainError } from "@redline/redline-domain";
import { InMemoryEvaluationRepository } from "./in-memory-evaluation-repository.test-support";
import { IngestDocuments } from "./ingest-documents";

// A stub reader: the ingest use-case only needs to confirm each document reads,
// so we return one element per known document and NOT_FOUND for the rest.
const readerOver = (knownDocumentIds: readonly string[]) => ({
  async readElements(_evaluationId: string, documentId: string) {
    if (!knownDocumentIds.includes(documentId)) {
      return err(domainError("NOT_FOUND", `no extraction for ${documentId}`));
    }
    return ok([{ documentId, elementOrder: 0, page: 1, text: "first element" }]);
  },
  async readChunks() {
    return ok([]);
  },
  async readTableCells() {
    return ok([]);
  },
});


describe("IngestDocuments", () => {
  it("confirms every document extracted and advances the stage to grouping", async () => {
    const repository = new InMemoryEvaluationRepository();
    const useCase = new IngestDocuments({
      repository,
      extractionReader: readerOver(["doc-a", "doc-b"]),
    });

    const result = await useCase.execute({
      evaluationId: "eval-1",
      evaluationName: "Cloud RFP",
      documentIds: ["doc-a", "doc-b"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.stage).toBe("grouping");
    // The evaluation is persisted at the new stage.
    const stored = repository.evaluations.get("eval-1");
    expect(stored?.stage).toBe("grouping");
  });

  it("fails EXTRACTION_FAILED when a document has no extraction yet", async () => {
    const repository = new InMemoryEvaluationRepository();
    const useCase = new IngestDocuments({
      repository,
      extractionReader: readerOver(["doc-a"]),
    });

    const result = await useCase.execute({
      evaluationId: "eval-1",
      evaluationName: "Cloud RFP",
      documentIds: ["doc-a", "doc-missing"],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("EXTRACTION_FAILED");
    // A failed ingest must not persist an advanced evaluation.
    expect(repository.evaluations.get("eval-1")).toBeUndefined();
  });

  it("rejects an empty document set as VALIDATION_FAILED", async () => {
    const repository = new InMemoryEvaluationRepository();
    const useCase = new IngestDocuments({
      repository,
      extractionReader: readerOver([]),
    });

    const result = await useCase.execute({
      evaluationId: "eval-1",
      evaluationName: "Cloud RFP",
      documentIds: [],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
