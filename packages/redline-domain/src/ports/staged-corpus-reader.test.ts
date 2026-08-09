import { describe, it, expect } from "vitest";
import { isOk, isErr, err, ok, type Result } from "../result";
import { domainError } from "../errors/domain-error";
import type {
  IStagedCorpusReader,
  StagedCorpus,
  StagedDocument,
} from "./staged-corpus-reader";

// The picker's spec. Creating an evaluation used to mean hand-writing a manifest
// whose `evaluationId` had to match, character for character, the prefix the
// corpus was staged under — `proc/{evaluationId}/` in object storage,
// `redline_chunks.evaluation_id` in the store, and the sidecar's
// `/extractions/{evaluation_id}/{document_id}`. A typo produced an evaluation
// whose documents silently did not exist. This port is what lets the operator
// *choose* a staged corpus instead of retyping its id.
//
// It reads what the sidecar's load path has already put in the store, so it
// answers from the same rows the classifier will later read. A corpus nothing
// has staged is not offered, which is the point: every corpus this returns is
// one an evaluation can actually be run against.

// A dependency-free in-memory reader over the (corpusId, documentId) rows a
// store would hold. Ordering is imposed on read so behaviour matches a real
// store rather than insertion order.
class InMemoryStagedCorpusReader implements IStagedCorpusReader {
  private readonly documentsByCorpus = new Map<string, StagedDocument[]>();

  seed(corpusId: string, documents: readonly StagedDocument[]): void {
    this.documentsByCorpus.set(corpusId, [...documents]);
  }

  async listCorpora(): Promise<Result<readonly StagedCorpus[]>> {
    const corpora = [...this.documentsByCorpus.entries()]
      .map(([corpusId, documents]) => ({ corpusId, documentCount: documents.length }))
      .sort((left, right) => left.corpusId.localeCompare(right.corpusId));
    return ok(corpora);
  }

  async listDocuments(corpusId: string): Promise<Result<readonly StagedDocument[]>> {
    const documents = this.documentsByCorpus.get(corpusId);
    if (documents === undefined) {
      return err(domainError("NOT_FOUND", `no corpus staged under ${corpusId}`));
    }

    return ok(
      [...documents].sort((left, right) => left.documentId.localeCompare(right.documentId)),
    );
  }
}

const document = (over: Partial<StagedDocument> & { documentId: string }): StagedDocument => ({
  chunkCount: 1,
  preview: "a first passage",
  ...over,
});

describe("IStagedCorpusReader — listing what an evaluation can be created over", () => {
  it("offers every staged corpus with the number of documents behind it", async () => {
    const reader = new InMemoryStagedCorpusReader();
    reader.seed("tender-2026-water", [document({ documentId: "hashA" }), document({ documentId: "hashB" })]);
    reader.seed("tender-2026-roads", [document({ documentId: "hashC" })]);

    const corpora = await reader.listCorpora();

    expect(isOk(corpora)).toBe(true);
    if (!isOk(corpora)) return;
    expect(corpora.data).toEqual([
      { corpusId: "tender-2026-roads", documentCount: 1 },
      { corpusId: "tender-2026-water", documentCount: 2 },
    ]);
  });

  it("lists no corpus when nothing has been staged, rather than failing", async () => {
    const corpora = await new InMemoryStagedCorpusReader().listCorpora();

    expect(isOk(corpora)).toBe(true);
    if (!isOk(corpora)) return;
    expect(corpora.data).toEqual([]);
  });

  it("lists a corpus's documents with a preview, so an opaque source hash is choosable", async () => {
    const reader = new InMemoryStagedCorpusReader();
    reader.seed("tender-2026-water", [
      document({ documentId: "hashB", chunkCount: 9, preview: "Response of Beta Pty Ltd" }),
      document({ documentId: "hashA", chunkCount: 4, preview: "Response of Alpha Pty Ltd" }),
    ]);

    const documents = await reader.listDocuments("tender-2026-water");

    expect(isOk(documents)).toBe(true);
    if (!isOk(documents)) return;
    expect(documents.data).toEqual([
      { documentId: "hashA", chunkCount: 4, preview: "Response of Alpha Pty Ltd" },
      { documentId: "hashB", chunkCount: 9, preview: "Response of Beta Pty Ltd" },
    ]);
  });

  it("refuses a corpus nothing has staged, so the caller cannot create an empty evaluation over it", async () => {
    const documents = await new InMemoryStagedCorpusReader().listDocuments("never-staged");

    expect(isErr(documents)).toBe(true);
    if (!isErr(documents)) return;
    expect(documents.error.code).toBe("NOT_FOUND");
  });
});
