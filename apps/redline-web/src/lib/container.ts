import {
  domainError,
  err,
  isErr,
  ok,
  type ClassificationRequest,
  type Evaluation,
  type IEvaluationRepository,
  type IFinancialExtractor,
  type ILanguageModel,
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

  // Opens the in-app review grid (Thread 12) for an evaluation that has reached
  // the review stage: reads the persisted ProcurementResponse[] (built by
  // BuildEvaluationTable) and wraps them in a ReviewGrid the shell renders. Read
  // side only — the grid never mutates, so this returns the grid, not a stage
  // transition.
  async openReviewGrid(input: { evaluationId: string }): Promise<Result<ReviewGrid>> {
    const responses = await this.container.repository.listResponses(input.evaluationId);
    if (isErr(responses)) return responses;
    return ok(new ReviewGrid(responses.data));
  }

  // Opens the pricing pivots (Thread 13) over the persisted ProcurementResponse[]:
  // reads the same built responses the review grid does and wraps them in a
  // PricingPivot the shell rolls up per brand / per requirement / brand×requirement.
  // Read side only — pivots never mutate.
  async openPricingPivot(input: { evaluationId: string }): Promise<Result<PricingPivot>> {
    const responses = await this.container.repository.listResponses(input.evaluationId);
    if (isErr(responses)) return responses;
    return ok(new PricingPivot(responses.data));
  }

  // Builds the Excel export workbook (Thread 14) for an evaluation at the review
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
