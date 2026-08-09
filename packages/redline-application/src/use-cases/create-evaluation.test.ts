import { describe, it, expect, beforeEach } from "vitest";
import {
  domainError,
  err,
  isErr,
  isOk,
  ok,
  type ClassificationLensDefinition,
  type IClassificationLensWriter,
  type IStagedCorpusReader,
  type Result,
  type StagedCorpus,
  type StagedDocument,
} from "@redline/redline-domain";
import { InMemoryEvaluationRepository } from "./in-memory-evaluation-repository.test-support";
import { CreateEvaluation, type CreateEvaluationInput } from "./create-evaluation";

// CreateEvaluation is the browser's way in. Before it, an evaluation could only
// be brought into being by a terminal script reading a hand-written manifest, so
// the specialist the product is for could not start one at all.
//
// The spec pins the three things that manifest got to assume and a form cannot:
// the evaluation's id IS the staged corpus's id (nothing else joins to the
// chunks the classifier reads), every chosen document is genuinely staged, and
// creating twice over the same corpus is refused rather than silently
// overwriting the first — the repository's saves are upserts by design.

class FakeStagedCorpusReader implements IStagedCorpusReader {
  private readonly documentsByCorpus = new Map<string, StagedDocument[]>();

  stage(corpusId: string, documentIds: readonly string[]): void {
    this.documentsByCorpus.set(
      corpusId,
      documentIds.map((documentId) => ({ documentId, chunkCount: 1, preview: "" })),
    );
  }

  async listCorpora(): Promise<Result<readonly StagedCorpus[]>> {
    return ok(
      [...this.documentsByCorpus.entries()].map(([corpusId, documents]) => ({
        corpusId,
        documentCount: documents.length,
      })),
    );
  }

  async listDocuments(corpusId: string): Promise<Result<readonly StagedDocument[]>> {
    const documents = this.documentsByCorpus.get(corpusId);
    if (documents === undefined) {
      return err(domainError("NOT_FOUND", `no corpus staged under ${corpusId}`));
    }
    return ok(documents);
  }
}

class RecordingLensWriter implements IClassificationLensWriter {
  saved: ClassificationLensDefinition | null = null;
  failWith: ReturnType<typeof domainError> | null = null;

  async saveLens(definition: ClassificationLensDefinition): Promise<Result<void>> {
    if (this.failWith) return err(this.failWith);
    this.saved = definition;
    return ok(undefined);
  }
}

let repository: InMemoryEvaluationRepository;
let stagedCorpusReader: FakeStagedCorpusReader;
let lensWriter: RecordingLensWriter;
let createEvaluation: CreateEvaluation;

const input = (over: Partial<CreateEvaluationInput> = {}): CreateEvaluationInput => ({
  corpusId: "tender-2026-water",
  name: "Water treatment panel 2026",
  documents: [
    { documentId: "hashA", brand: "Alpha Pty Ltd" },
    { documentId: "hashB", brand: "Beta Pty Ltd" },
  ],
  fields: [
    { name: "Warranty", definition: "The warranty period offered and what it covers." },
    { name: "Delivery", definition: "Lead time and delivery obligations." },
  ],
  ...over,
});

beforeEach(() => {
  repository = new InMemoryEvaluationRepository();
  stagedCorpusReader = new FakeStagedCorpusReader();
  stagedCorpusReader.stage("tender-2026-water", ["hashA", "hashB", "hashC"]);
  lensWriter = new RecordingLensWriter();
  createEvaluation = new CreateEvaluation({ repository, stagedCorpusReader, lensWriter });
});

describe("CreateEvaluation — the evaluation itself", () => {
  it("takes the staged corpus's id as the evaluation id, so the read path joins", async () => {
    const created = await createEvaluation.execute(input());

    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.data.id).toBe("tender-2026-water");
    expect(created.data.name).toBe("Water treatment panel 2026");
  });

  it("starts at documents_uploaded, so the run can still walk the stage ladder", async () => {
    const created = await createEvaluation.execute(input());

    expect(isOk(created)).toBe(true);
    if (!isOk(created)) return;
    expect(created.data.stage).toBe("documents_uploaded");
  });

  it("refuses a blank name", async () => {
    const created = await createEvaluation.execute(input({ name: "   " }));

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses to create a second evaluation over a corpus that already has one", async () => {
    const first = await createEvaluation.execute(input());
    expect(isOk(first)).toBe(true);

    const second = await createEvaluation.execute(input({ name: "A different name" }));

    expect(isErr(second)).toBe(true);
    if (!isErr(second)) return;
    expect(second.error.code).toBe("ALREADY_EXISTS");
    expect(repository.evaluations.get("tender-2026-water")?.name).toBe("Water treatment panel 2026");
  });
});

describe("CreateEvaluation — the documents", () => {
  it("refuses a corpus nothing has staged", async () => {
    const created = await createEvaluation.execute(input({ corpusId: "never-staged" }));

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("NOT_FOUND");
  });

  it("refuses a document the corpus does not carry, naming it", async () => {
    const created = await createEvaluation.execute(
      input({ documents: [{ documentId: "hashZ", brand: "Zeta" }] }),
    );

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("VALIDATION_FAILED");
    expect(created.error.message).toContain("hashZ");
  });

  it("refuses a selection with no documents", async () => {
    const created = await createEvaluation.execute(input({ documents: [] }));

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses the same document assigned to two brands, which would double-count its pricing", async () => {
    const created = await createEvaluation.execute(
      input({
        documents: [
          { documentId: "hashA", brand: "Alpha Pty Ltd" },
          { documentId: "hashA", brand: "Beta Pty Ltd" },
        ],
      }),
    );

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("VALIDATION_FAILED");
    expect(created.error.message).toContain("hashA");
  });
});

describe("CreateEvaluation — the brands", () => {
  it("records one vendor per distinct brand", async () => {
    await createEvaluation.execute(input());

    const vendors = await repository.listVendors("tender-2026-water");
    expect(isOk(vendors)).toBe(true);
    if (!isOk(vendors)) return;
    expect(vendors.data.map((vendor) => vendor.displayName).sort()).toEqual([
      "Alpha Pty Ltd",
      "Beta Pty Ltd",
    ]);
  });

  it("groups every document of one brand into that brand's single response group", async () => {
    await createEvaluation.execute(
      input({
        documents: [
          { documentId: "hashA", brand: "Alpha Pty Ltd" },
          { documentId: "hashC", brand: "Alpha Pty Ltd" },
          { documentId: "hashB", brand: "Beta Pty Ltd" },
        ],
      }),
    );

    const groups = await repository.listResponseGroups("tender-2026-water");
    expect(isOk(groups)).toBe(true);
    if (!isOk(groups)) return;
    expect(groups.data).toHaveLength(2);

    const alpha = groups.data.find((group) => group.label === "Alpha Pty Ltd");
    expect(alpha?.documentIds).toEqual(["hashA", "hashC"]);
    expect(alpha?.isConsortiumResponse).toBe(false);
  });

  it("refuses a blank brand rather than inventing an unnamed vendor", async () => {
    const created = await createEvaluation.execute(
      input({ documents: [{ documentId: "hashA", brand: "  " }] }),
    );

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("CreateEvaluation — the fields", () => {
  it("writes the fields as the evaluation's lens topics, in the order given", async () => {
    await createEvaluation.execute(input());

    expect(lensWriter.saved?.evaluationId).toBe("tender-2026-water");
    expect(lensWriter.saved?.topics.map((topic) => topic.name)).toEqual(["Warranty", "Delivery"]);
    expect(lensWriter.saved?.topics[0]?.definition).toBe(
      "The warranty period offered and what it covers.",
    );
  });

  it("scopes topic ids to the corpus, because a topic id is a global primary key", async () => {
    await createEvaluation.execute(input());

    for (const topic of lensWriter.saved?.topics ?? []) {
      expect(topic.id.startsWith("tender-2026-water:")).toBe(true);
    }
  });

  it("writes no hard rules, so a cold-start lens adjudicates every field", async () => {
    await createEvaluation.execute(input());

    expect(lensWriter.saved?.rules).toEqual([]);
  });

  it("refuses an evaluation with no fields, which would classify against nothing", async () => {
    const created = await createEvaluation.execute(input({ fields: [] }));

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a field with no definition, which the adjudicator cannot reason from", async () => {
    const created = await createEvaluation.execute(
      input({ fields: [{ name: "Warranty", definition: "  " }] }),
    );

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("VALIDATION_FAILED");
  });

  it("surfaces a lens write failure rather than leaving a lensless evaluation unreported", async () => {
    lensWriter.failWith = domainError("INFRA_FAILURE", "lens store unreachable");

    const created = await createEvaluation.execute(input());

    expect(isErr(created)).toBe(true);
    if (!isErr(created)) return;
    expect(created.error.code).toBe("INFRA_FAILURE");
  });
});
