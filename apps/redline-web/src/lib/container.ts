import {
  domainError,
  err,
  isErr,
  ok,
  type ClassificationRequest,
  type Evaluation,
  type ExtractionElement,
  type IAdjudicator,
  type IChunkStore,
  type IClassificationLensReader,
  type IClassificationLensWriter,
  type IEvaluationRepository,
  type IFinancialExtractor,
  type ILanguageModel,
  type IMoneySpanStore,
  type IProcurementClassifier,
  type IProcurementExtractionReader,
  type IStagedCorpusReader,
  type IStagedCorpusWriter,
  type IWomblexRunTrigger,
  type ProcurementResponse,
  type RequirementClassification,
  type ResponseGroup,
  type Result,
  type StagedCorpus,
  type StagedDocument,
  type Vendor,
} from "@redline/redline-domain";
import {
  AssignDocumentsToGroups,
  BuildEvaluationTable,
  ClassifyResponseGroup,
  ColdStartClassifier,
  CreateEvaluation,
  IngestDocuments,
  MoneySpanFinancialExtractor,
  type CreateEvaluationInput,
} from "@redline/redline-application";
import { WorkflowManager } from "./workflow-manager";
import { CreateCorpusController } from "./create-corpus-controller";
import { RunStatusController } from "./run-status-controller";
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
  // The create half. Until an evaluation could be created from the browser the
  // served container carried no write capability at all — an evaluation existed
  // only if a terminal script had made one.
  readonly stagedCorpusReader: IStagedCorpusReader;
  readonly lensWriter: IClassificationLensWriter;
  // The run half. Until now the served container carried the create use-case but
  // no way to stage the bytes a run reads or to fire the run itself — an
  // evaluation could be composed from the browser, but the run that turns it into
  // a review grid still needed a terminal. These two seams close that gap: the
  // object-store writer stages a specialist's chosen bytes under the evaluation's
  // input prefix, and the run trigger fires ingest → lens → grouping → build.
  readonly stagedCorpusWriter: IStagedCorpusWriter;
  readonly runTrigger: IWomblexRunTrigger;
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
  private readonly createEvaluationUseCase: CreateEvaluation;
  private readonly ingestDocuments: IngestDocuments;
  // The run-side controllers, composed over the two write seams. Carried on the
  // workflow controller so the served router reaches the whole create-and-run
  // surface through one object, the way it reaches the read side.
  private readonly createCorpusController: CreateCorpusController;
  private readonly runStatusController: RunStatusController;

  constructor(private readonly container: WorkflowContainer) {
    this.createEvaluationUseCase = new CreateEvaluation({
      repository: container.repository,
      stagedCorpusReader: container.stagedCorpusReader,
      lensWriter: container.lensWriter,
    });
    this.createCorpusController = new CreateCorpusController({
      writer: container.stagedCorpusWriter,
      runTrigger: container.runTrigger,
    });
    this.runStatusController = new RunStatusController({ runTrigger: container.runTrigger });
    this.ingestDocuments = new IngestDocuments({
      repository: container.repository,
      extractionReader: container.extractionReader,
    });
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

  // The three calls the create screen makes. They are the only write path the
  // served container exposes: everything else here reads.
  listStagedCorpora(): Promise<Result<readonly StagedCorpus[]>> {
    return this.container.stagedCorpusReader.listCorpora();
  }

  listStagedDocuments(input: { corpusId: string }): Promise<Result<readonly StagedDocument[]>> {
    return this.container.stagedCorpusReader.listDocuments(input.corpusId);
  }

  createEvaluation(input: CreateEvaluationInput): Promise<Result<Evaluation>> {
    return this.createEvaluationUseCase.execute(input);
  }

  // The ingest-and-run surface. Reached through the workflow controller so the
  // served router holds one object, not three: the corpus controller stages the
  // uploaded bytes and fires the run, and the status controller polls and
  // resumes the run the trigger returned. Composing the evaluation over the
  // finished corpus is /evaluations/new's job, through createEvaluation above.
  corpus(): CreateCorpusController {
    return this.createCorpusController;
  }

  runStatus(): RunStatusController {
    return this.runStatusController;
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

  // Post-run population (build plan §5; delivery-plan §2 item 1). Takes a
  // settled evaluation — created over a finished corpus, its vendors, groups and
  // lens already persisted but no responses yet — through the reading passes the
  // seed script drives: IngestDocuments (confirm every document reads back,
  // advance to grouping), then the composition (grouping → classifying via
  // AssignDocumentsToGroups over the persisted groups) and BuildEvaluationTable
  // (classifying → review, persisting the ProcurementResponse[] the grid reads).
  //
  // Re-runnable by design: the sidecar's resume re-fires the whole sequence, so
  // a run that already reached review must not re-read and double-write. When the
  // response set is already there, that is the answer — return it and touch
  // nothing, because the in-memory (and Drizzle) saves append/upsert and a second
  // pass would otherwise duplicate every row.
  async populate(input: {
    evaluationId: string;
  }): Promise<Result<readonly ProcurementResponse[]>> {
    const evaluation = await this.container.repository.findEvaluation(input.evaluationId);
    if (isErr(evaluation)) return evaluation;

    const existing = await this.container.repository.listResponses(input.evaluationId);
    if (isErr(existing)) return existing;
    if (existing.data.length > 0) return ok(existing.data);

    const groups = await this.container.repository.listResponseGroups(input.evaluationId);
    if (isErr(groups)) return groups;
    const vendors = await this.container.repository.listVendors(input.evaluationId);
    if (isErr(vendors)) return vendors;

    const documentIds = [
      ...new Set(groups.data.flatMap((group) => group.documentIds)),
    ];

    const ingested = await this.ingestDocuments.execute({
      evaluationId: input.evaluationId,
      evaluationName: evaluation.data.name,
      documentIds,
    });
    if (isErr(ingested)) return ingested;

    const manager = this.hydrateManager({
      evaluationId: input.evaluationId,
      stage: ingested.data.stage,
      documentIds,
      vendors: vendors.data,
      groups: groups.data,
    });
    if (isErr(manager)) return manager;

    const advanced = await this.advance(manager.data);
    if (isErr(advanced)) return advanced;

    return this.buildTable({ evaluationId: input.evaluationId });
  }

  // Replays the persisted composition into a WorkflowManager so advance() can
  // re-persist and re-transition it exactly as the grouping surface would. The
  // create step already composed vendors and groups; populate is not the surface
  // that authors them, so it reconstructs rather than reinvents. Every step goes
  // through the manager's smart constructors, so a stored group the domain would
  // now reject surfaces here rather than at the use-case.
  private hydrateManager(input: {
    evaluationId: string;
    stage: Evaluation["stage"];
    documentIds: readonly string[];
    vendors: readonly Vendor[];
    groups: readonly ResponseGroup[];
  }): Result<WorkflowManager> {
    const manager = new WorkflowManager({
      evaluationId: input.evaluationId,
      stage: input.stage,
      documentIds: input.documentIds,
    });

    for (const vendor of input.vendors) {
      const added = manager.addVendor(vendor);
      if (isErr(added)) return added;
    }

    for (const group of input.groups) {
      const created = manager.createGroup({
        id: group.id,
        label: group.label,
        vendorIds: group.vendorIds,
      });
      if (isErr(created)) return created;

      for (const documentId of group.documentIds) {
        const assigned = manager.assignDocument(group.id, documentId);
        if (isErr(assigned)) return assigned;
      }
    }

    return ok(manager);
  }

  // Every evaluation in the store, newest first — what the /evaluations index
  // lists so a specialist can reach a review grid without being handed an id out
  // of band. Read side only, and deliberately thin: there is nothing to shape
  // beyond the aggregate root's own name and stage.
  listEvaluations(): Promise<Result<readonly Evaluation[]>> {
    return this.container.repository.listEvaluations();
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

  // Opens one document's extracted elements — the other end of every source
  // deep-link the review grid renders. Reads through IProcurementExtractionReader
  // (the JSON presentation seam of ADR-0003/0017), so the heavy Parquet/womblex
  // stack stays in the sidecar. Read side only, and deliberately unshaped: the
  // ordering and the anchor the `element` query parameter cites belong to
  // renderDocumentView, which the route applies.
  openDocument(input: {
    evaluationId: string;
    documentId: string;
  }): Promise<Result<readonly ExtractionElement[]>> {
    return this.container.extractionReader.readElements(input.evaluationId, input.documentId);
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
  readonly stagedCorpusReader: IStagedCorpusReader;
  readonly lensWriter: IClassificationLensWriter;
  readonly stagedCorpusWriter: IStagedCorpusWriter;
  readonly runTrigger: IWomblexRunTrigger;
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
// port (ADR-0008 first pass in the ADR-0018-addendum
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
