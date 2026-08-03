import {
  domainError,
  err,
  isErr,
  ok,
  type ClassificationRequest,
  type Evaluation,
  type IAdjudicator,
  type IChunkStore,
  type IClassificationLensReader,
  type IEvaluationRepository,
  type IFinancialExtractor,
  type ILanguageModel,
  type IMoneySpanStore,
  type IProcurementClassifier,
  type IProcurementExtractionReader,
  type ProcurementResponse,
  type RequirementClassification,
  type Result,
} from "@redline/redline-domain";
import {
  AssignDocumentsToGroups,
  BuildEvaluationTable,
  ClassifyResponseGroup,
  ColdStartClassifier,
  MoneySpanFinancialExtractor,
} from "@redline/redline-application";
import { WorkflowManager } from "./workflow-manager";
import { ReviewGrid } from "./review-grid";
import { PricingPivot } from "./pricing-pivot";
import { buildEvaluationWorkbook, type EvaluationWorkbook } from "./excel-export";

// Container / WorkflowController — the app's wiring (CLAUDE.md: "wiring lives in
// lib/container.ts"). Apps import only @redline/redline-application (use-cases)
// and @redline/redline-domain (ports/types); the concrete adapters (Numbatch,
// womblex, Drizzle, a model) are injected as ports here, so the control surface
// stays testable with in-memory fakes and swaps to real adapters in production
// (buildProductionContainer, Thread 16 / deployment). The controller drives the
// specialist workflow: open a WorkflowManager for the grouping stage, advance it
// (persist the composition via AssignDocumentsToGroups), (re)classify a single
// group, and build the review table.

export interface WorkflowContainer {
  readonly repository: IEvaluationRepository;
  readonly classifier: IProcurementClassifier;
  readonly financialExtractor: IFinancialExtractor;
  readonly extractionReader: IProcurementExtractionReader;
  readonly languageModel: ILanguageModel;
  readonly productName: string;
}

export interface OpenWorkflowInput {
  readonly evaluationId: string;
  readonly documentIds: readonly string[];
}

export class WorkflowController {
  private readonly assignDocumentsToGroups: AssignDocumentsToGroups;
  private readonly classifyResponseGroup: ClassifyResponseGroup;
  private readonly buildEvaluationTable: BuildEvaluationTable;

  constructor(private readonly container: WorkflowContainer) {
    this.assignDocumentsToGroups = new AssignDocumentsToGroups({
      repository: container.repository,
    });
    this.classifyResponseGroup = new ClassifyResponseGroup({ classifier: container.classifier });
    this.buildEvaluationTable = new BuildEvaluationTable({
      repository: container.repository,
      classifier: container.classifier,
      financialExtractor: container.financialExtractor,
      extractionReader: container.extractionReader,
      languageModel: container.languageModel,
      productName: container.productName,
    });
  }

  async openWorkflow(input: OpenWorkflowInput): Promise<Result<WorkflowManager>> {
    const evaluation = await this.container.repository.findEvaluation(input.evaluationId);
    if (isErr(evaluation)) return evaluation;

    return ok(
      new WorkflowManager({
        evaluationId: input.evaluationId,
        stage: evaluation.data.stage,
        documentIds: input.documentIds,
      }),
    );
  }

  async advance(manager: WorkflowManager): Promise<Result<Evaluation>> {
    const assignment = manager.toAssignmentInput();
    if (isErr(assignment)) return assignment;

    return this.assignDocumentsToGroups.execute(assignment.data);
  }

  reclassifyGroup(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>> {
    return this.classifyResponseGroup.execute(request);
  }

  buildTable(input: { evaluationId: string }): Promise<Result<readonly ProcurementResponse[]>> {
    return this.buildEvaluationTable.execute(input);
  }

  // Opens the in-app review grid for an evaluation that has reached
  // the review stage: reads the persisted ProcurementResponse[] (built by
  // BuildEvaluationTable) and wraps them in a ReviewGrid the shell renders. Read
  // side only — the grid never mutates, so this returns the grid, not a stage
  // transition.
  async openReviewGrid(input: { evaluationId: string }): Promise<Result<ReviewGrid>> {
    const responses = await this.container.repository.listResponses(input.evaluationId);
    if (isErr(responses)) return responses;
    return ok(new ReviewGrid(responses.data));
  }

  // Opens the pricing pivots over the persisted ProcurementResponse[]:
  // reads the same built responses the review grid does and wraps them in a
  // PricingPivot the shell rolls up per brand / per requirement / brand×requirement.
  // Read side only — pivots never mutate.
  async openPricingPivot(input: { evaluationId: string }): Promise<Result<PricingPivot>> {
    const responses = await this.container.repository.listResponses(input.evaluationId);
    if (isErr(responses)) return responses;
    return ok(new PricingPivot(responses.data));
  }

  // Builds the Excel export workbook for an evaluation at the review
  // stage: reads the persisted ProcurementResponse[] once and shapes them into
  // one review sheet plus one sheet per pivot, all with numeric currency cells
  // and source deep-link hyperlinks. Read side only — export never mutates. The
  // shell hands this to exportEvaluationXlsx (the lazy browser writer) to trigger
  // the download; returning the workbook keeps the write side testable without a
  // browser.
  async buildWorkbook(input: { evaluationId: string }): Promise<Result<EvaluationWorkbook>> {
    const responses = await this.container.repository.listResponses(input.evaluationId);
    if (isErr(responses)) return responses;
    return ok(
      buildEvaluationWorkbook({
        evaluationId: input.evaluationId,
        grid: new ReviewGrid(responses.data),
        pivot: new PricingPivot(responses.data),
      }),
    );
  }
}

// Assembles the production container from the concrete adapters. Kept as a thin
// factory so a deployment (or Thread 16's standalone workspace) wires the real
// Numbatch/womblex/Drizzle/model adapters in exactly one place; the controller
// and manager never see a concrete adapter.
export interface ProductionContainerParts {
  readonly repository: IEvaluationRepository;
  readonly classifier: IProcurementClassifier;
  readonly financialExtractor: IFinancialExtractor;
  readonly extractionReader: IProcurementExtractionReader;
  readonly languageModel: ILanguageModel;
  readonly productName: string;
}

export const buildContainer = (parts: ProductionContainerParts): Result<WorkflowContainer> => {
  const productName = parts.productName.trim();
  if (productName === "") {
    return err(domainError("VALIDATION_FAILED", "product name must not be blank"));
  }
  return ok({ ...parts, productName });
};

// The cold-start classification path, composed behind the IProcurementClassifier
// port (delivery-plan item 1b; ADR-0008 first pass in the ADR-0018-addendum
// shape). This is where a deployment with no Numbatch and no trained adapter
// wires classification: hard rules + LLM adjudication over the store's
// exact/structural fetch, no nearest-neighbour step. The result is an ordinary
// IProcurementClassifier a caller hands to `buildContainer` as `parts.classifier`
// — the trained Numbatch overlay would be wired the same way at the same seam,
// and the controller cannot tell which is behind the port (ADR-0008 D2).
export interface ColdStartClassifierParts {
  readonly chunkStore: IChunkStore;
  readonly adjudicator: IAdjudicator;
  // The route from an evaluation to its lens (topics, hard rules, per-document
  // identifier tokens), resolved per call rather than bound here — one composed
  // classifier therefore serves every evaluation in the process.
  readonly lensReader: IClassificationLensReader;
}

export const buildColdStartClassifier = (
  parts: ColdStartClassifierParts,
): IProcurementClassifier =>
  new ColdStartClassifier({
    chunkStore: parts.chunkStore,
    adjudicator: parts.adjudicator,
    lensReader: parts.lensReader,
  });

// The item-1 seam: the real IFinancialExtractor, composed behind the same port
// the Numbatch one satisfies. It reads womblex's money spans (IMoneySpanStore,
// materialised from `*.money_spans.parquet` — ADR-0017) and attributes a
// document's summed AUD to the requirement its classification matched with the
// highest confidence. A deployment wires this as `parts.financialExtractor`,
// replacing the Numbatch extractor at the port — the controller cannot tell which
// is behind it. This is what puts real currency in the review grid and pivots.
export interface MoneySpanFinancialExtractorParts {
  readonly moneySpanStore: IMoneySpanStore;
}

export const buildMoneySpanFinancialExtractor = (
  parts: MoneySpanFinancialExtractorParts,
): IFinancialExtractor =>
  new MoneySpanFinancialExtractor({ moneySpanStore: parts.moneySpanStore });
