import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err, domainError, makeEvaluation, makeHardRuleSet } from "@redline/redline-domain";
import type {
  Adjudication,
  AdjudicationRequest,
  ChunkRow,
  ClassificationLens,
  HardRuleCandidate,
  HardRuleSet,
  IAdjudicator,
  IChunkStore,
  IClassificationLensReader,
  IMoneySpanStore,
  MoneySpanFilter,
  MoneySpanRow,
  Result,
  ScoredChunkRef,
  StructureFilter,
  Topic,
} from "@redline/redline-domain";
import { WorkflowController, buildColdStartClassifier, buildContainer, buildMoneySpanFinancialExtractor } from "./container";
import {
  InMemoryRepository,
  classifier,
  extractionReader,
  financialExtractor,
  languageModel,
  lensWriter,
  runTrigger,
  stagedCorpusReader,
  stagedCorpusWriter,
} from "./container-test-fixtures";

// The item-1b seam: buildColdStartClassifier composes the untrained first pass
// (hard rules + adjudication over exact fetch, no nearest-neighbour) into an
// ordinary IProcurementClassifier the container accepts as `parts.classifier`.
// This proves the cold-start path is wired *behind the port* — the controller,
// once built with it, reclassifies a group with no Numbatch and no trained
// adapter anywhere in the graph.
describe("container — cold-start classifier wiring", () => {
  const topics: readonly Topic[] = [
    { id: "req-support", name: "Support", definition: "support services" },
    { id: "req-hosting", name: "Hosting", definition: "hosting services" },
  ];

  // A store that answers the exact-fetch half and refuses the deferred
  // similarity half — the ADR-0018-addendum shape the cold-start path runs over.
  class FakeChunkStore implements IChunkStore {
    constructor(private readonly rows: readonly ChunkRow[]) {}
    async fetchChunks(
      _e: string,
      chunkIds: readonly string[],
    ): Promise<Result<readonly ChunkRow[]>> {
      return ok(
        chunkIds
          .map((id) => this.rows.find((r) => r.chunkId === id))
          .filter((r): r is ChunkRow => r !== undefined),
      );
    }
    async fetchByStructure(
      _e: string,
      filter: StructureFilter,
    ): Promise<Result<readonly ChunkRow[]>> {
      return ok(this.rows.filter((r) => !filter.documentId || r.documentId === filter.documentId));
    }
    async findSimilar(): Promise<Result<readonly ScoredChunkRef[]>> {
      return err(domainError("NOT_IMPLEMENTED", "deferred (ADR-0018 addendum)"));
    }
  }

  const adjudicator: IAdjudicator = {
    async adjudicate(request: AdjudicationRequest): Promise<Result<Adjudication>> {
      const verdict: Adjudication = {
        documentId: request.documentId,
        topics: [
          {
            topicId: request.candidates[0].topicId,
            evidenceChunkIds: [request.passages[0].chunkId],
            rationale: "chosen on the passages",
          },
        ],
        exception: null,
        cost: null,
      };
      return ok(verdict);
    },
  };

  // The evaluation-scoped lens the classifier resolves per call. A fixed lens
  // stands in for the persisted one until DrizzleClassificationLensReader lands.
  const lensReaderFor = (
    ruleSet: HardRuleSet,
    candidates: readonly HardRuleCandidate[] = [],
  ): IClassificationLensReader => ({
    async readLens(): Promise<Result<ClassificationLens>> {
      return ok({ topics, ruleSet, candidates });
    },
  });

  it("reclassifies a group through a container wired with the cold-start path (no Numbatch)", async () => {
    const store = new FakeChunkStore([
      {
        documentId: "doc-1",
        chunkId: "doc-1:0",
        chunkIndex: 0,
        contentType: "narrative",
        page: 1,
        text: "we provide support",
      },
    ]);
    const ruleSet = makeHardRuleSet({ rules: [] });
    if (isErr(ruleSet)) throw new Error("bad rules");

    const coldStart = buildColdStartClassifier({
      chunkStore: store,
      adjudicator,
      lensReader: lensReaderFor(ruleSet.data),
    });

    const repository = new InMemoryRepository();
    const evaluation = makeEvaluation({ id: "eval-1", name: "Tender", stage: "classifying" });
    if (isErr(evaluation)) throw new Error("bad seed");
    repository.seed(evaluation.data);

    const container = buildContainer({
      repository,
      classifier: coldStart,
      financialExtractor,
      extractionReader,
      languageModel,
      stagedCorpusReader,
      lensWriter,
      stagedCorpusWriter,
      runTrigger,
      productName: "Platform",
    });
    expect(isOk(container)).toBe(true);
    if (!isOk(container)) return;

    const controller = new WorkflowController(container.data);
    const result = await controller.reclassifyGroup({
      evaluationId: "eval-1",
      responseGroupId: "g-acme",
      documentIds: ["doc-1"],
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      documentId: "doc-1",
      requirementId: "req-support",
      sourceChunkId: "doc-1:0",
    });
  });

  it("resolves a hard-rule-claimed document through the wired path without the model", async () => {
    let modelCalls = 0;
    const recordingAdjudicator: IAdjudicator = {
      async adjudicate(request: AdjudicationRequest): Promise<Result<Adjudication>> {
        modelCalls += 1;
        return ok({
          documentId: request.documentId,
          topics: [
            {
              topicId: request.candidates[0].topicId,
              evidenceChunkIds: request.passages.map((passage) => passage.chunkId),
              rationale: "",
            },
          ],
          exception: null,
          cost: null,
        });
      },
    };
    const ruleSet = makeHardRuleSet({
      rules: [{ id: "r1", pattern: "SEC-*", topicId: "req-support" }],
    });
    if (isErr(ruleSet)) throw new Error("bad rules");

    const coldStart = buildColdStartClassifier({
      chunkStore: new FakeChunkStore([]),
      adjudicator: recordingAdjudicator,
      lensReader: lensReaderFor(ruleSet.data, [{ documentId: "SEC-014", subjects: ["SEC-014"] }]),
    });

    const result = await coldStart.classifyResponseGroup({
      evaluationId: "eval-1",
      responseGroupId: "g",
      documentIds: ["SEC-014"],
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data[0].requirementId).toBe("req-support");
    expect(result.data[0].sourceChunkId).toBeNull();
    expect(modelCalls).toBe(0);
  });
});

// buildMoneySpanFinancialExtractor composes the real IFinancialExtractor (womblex
// money spans → summed AUD per matched requirement) behind the same port the
// Numbatch one satisfies. This proves the money-span path is wired *behind the
// port* — the controller, once built with it, puts real currency in the review
// grid, and the per-brand pivot totals it.
describe("container — money-span financial extractor wiring", () => {
  class FakeMoneySpanStore implements IMoneySpanStore {
    constructor(private readonly rows: readonly MoneySpanRow[]) {}
    async fetchByDocument(
      evaluationId: string,
      documentId: string,
    ): Promise<Result<readonly MoneySpanRow[]>> {
      void evaluationId;
      return ok(this.rows.filter((row) => row.documentId === documentId));
    }
    async fetchByStructure(
      evaluationId: string,
      filter: MoneySpanFilter,
    ): Promise<Result<readonly MoneySpanRow[]>> {
      void evaluationId;
      return ok(
        this.rows.filter(
          (row) => filter.documentId === undefined || row.documentId === filter.documentId,
        ),
      );
    }
  }

  const money = (over: Partial<MoneySpanRow> = {}): MoneySpanRow => ({
    documentId: "doc-1",
    locus: "table_cell",
    textSource: null,
    startChar: null,
    endChar: null,
    page: null,
    elementOrder: null,
    parentElementOrder: 4,
    sheet: null,
    rowIndex: 1,
    columnIndex: 0,
    text: "1200",
    value: "1200.0000",
    currency: "AUD",
    currencySource: "column_header",
    evidence: "header+numeric",
    modifier: null,
    multiplier: null,
    negative: false,
    confidence: 0.92,
    rangeGroup: null,
    rangeRole: null,
    columnId: "elem4:col0",
    context: null,
    ...over,
  });

  it("builds a real tender's priced rows into numeric AUD in the review grid and pivot", async () => {
    // The header-evidenced bare-number column (98.7% case): two priced rows whose
    // money-ness came from the `Amount (AUD)` header, so the cell text is a bare
    // number and the currency rides on the span.
    const store = new FakeMoneySpanStore([
      money({ rowIndex: 1, text: "1200", value: "1200.0000" }),
      money({ rowIndex: 2, text: "800", value: "800.0000" }),
    ]);
    const realExtractor = buildMoneySpanFinancialExtractor({ moneySpanStore: store });

    const repository = new InMemoryRepository();
    const evaluation = makeEvaluation({ id: "eval-1", name: "Tender", stage: "classifying" });
    if (isErr(evaluation)) throw new Error("bad seed");
    repository.seed(evaluation.data);
    await repository.saveVendor("eval-1", {
      id: "v-acme",
      displayName: "Acme",
      isConsortium: false,
      memberVendorIds: [],
    });
    await repository.saveResponseGroup({
      id: "g-acme",
      evaluationId: "eval-1",
      vendorIds: ["v-acme"],
      label: "Acme Bid",
      documentIds: ["doc-1"],
      isConsortiumResponse: false,
    });

    const container = buildContainer({
      repository,
      classifier,
      financialExtractor: realExtractor,
      extractionReader,
      languageModel,
      stagedCorpusReader,
      lensWriter,
      stagedCorpusWriter,
      runTrigger,
      productName: "Platform",
    });
    expect(isOk(container)).toBe(true);
    if (!isOk(container)) return;

    const controller = new WorkflowController(container.data);
    const built = await controller.buildTable({ evaluationId: "eval-1" });
    expect(isOk(built)).toBe(true);
    if (!isOk(built)) return;

    // The priced rows summed to a real number on the matched requirement.
    expect(built.data).toHaveLength(1);
    expect(built.data[0].costing.estimateAud).toBe(2000);

    // The review grid shows it numeric.
    const grid = await controller.openReviewGrid({ evaluationId: "eval-1" });
    if (!isOk(grid)) throw new Error("grid failed");
    const rows = grid.data.all();
    expect(rows[0].cells.estimateAud.isNumeric).toBe(true);
    expect(rows[0].cells.estimateAud.sortValue).toBe(2000);

    // The per-brand pivot totals the same figure.
    const pivot = await controller.openPricingPivot({ evaluationId: "eval-1" });
    if (!isOk(pivot)) throw new Error("pivot failed");
    const perBrand = pivot.data.compute({ axis: "brand", measure: "sum" });
    expect(perBrand.rows[0].key).toBe("Acme");
    expect(perBrand.grandTotal.value).toBe(2000);
  });
});
