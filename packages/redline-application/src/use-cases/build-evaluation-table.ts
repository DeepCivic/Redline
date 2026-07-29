import {
  isErr,
  makeProcurementResponse,
  ok,
  withIntakeStage,
  type FinancialExtraction,
  type IEvaluationRepository,
  type IFinancialExtractor,
  type ILanguageModel,
  type IProcurementClassifier,
  type IProcurementExtractionReader,
  type ProcurementResponse,
  type RequirementClassification,
  type ResponseGroup,
  type Result,
} from "@redline/redline-domain";
import { ClassifyResponseGroup } from "./classify-response-group";
import { ExtractFinancials } from "./extract-financials";

// BuildEvaluationTable — the composition at the heart of Thread 10. For an
// evaluation at the `classifying` stage it walks every response group and joins:
//   • the classifier's per-(document, requirement) roll-ups (confidence + chunk),
//   • the financial worker's per-(document, requirement) costing,
//   • a one-paragraph AI summary over the matched passages,
// into one ProcurementResponse per (group, document, matched requirement) — the
// review grid's natural row (build plan §5) — persists them, and advances the
// stage to `review`. Currency stays a real number end-to-end (ADR).
export interface BuildEvaluationTableDependencies {
  readonly repository: IEvaluationRepository;
  readonly classifier: IProcurementClassifier;
  readonly financialExtractor: IFinancialExtractor;
  readonly extractionReader: IProcurementExtractionReader;
  readonly languageModel: ILanguageModel;
  // The specialist names the offering per evaluation; a per-group product name
  // is a Thread 11 concern, so one name covers the evaluation for now.
  readonly productName: string;
}

export interface BuildEvaluationTableInput {
  readonly evaluationId: string;
}

const costingKey = (documentId: string, requirementId: string): string =>
  `${documentId}::${requirementId}`;

export class BuildEvaluationTable {
  private readonly classifyResponseGroup: ClassifyResponseGroup;
  private readonly extractFinancials: ExtractFinancials;

  constructor(private readonly dependencies: BuildEvaluationTableDependencies) {
    this.classifyResponseGroup = new ClassifyResponseGroup({ classifier: dependencies.classifier });
    this.extractFinancials = new ExtractFinancials({
      financialExtractor: dependencies.financialExtractor,
    });
  }

  async execute(
    input: BuildEvaluationTableInput,
  ): Promise<Result<readonly ProcurementResponse[]>> {
    const evaluation = await this.dependencies.repository.findEvaluation(input.evaluationId);
    if (isErr(evaluation)) return evaluation;

    const review = withIntakeStage(evaluation.data, "review");
    if (isErr(review)) return review;

    const groups = await this.dependencies.repository.listResponseGroups(input.evaluationId);
    if (isErr(groups)) return groups;

    const vendorNames = await this.vendorNamesById(input.evaluationId);
    if (isErr(vendorNames)) return vendorNames;

    const responses: ProcurementResponse[] = [];
    for (const group of groups.data) {
      const groupResponses = await this.buildGroup(
        input.evaluationId,
        group,
        vendorNames.data,
      );
      if (isErr(groupResponses)) return groupResponses;
      responses.push(...groupResponses.data);
    }

    const saved = await this.dependencies.repository.saveResponses(responses);
    if (isErr(saved)) return saved;

    const advanced = await this.dependencies.repository.saveEvaluation(review.data);
    if (isErr(advanced)) return advanced;

    return ok(responses);
  }

  private async vendorNamesById(
    evaluationId: string,
  ): Promise<Result<ReadonlyMap<string, string>>> {
    const vendors = await this.dependencies.repository.listVendors(evaluationId);
    if (isErr(vendors)) return vendors;
    return ok(new Map(vendors.data.map((vendor) => [vendor.id, vendor.displayName])));
  }

  private async buildGroup(
    evaluationId: string,
    group: ResponseGroup,
    vendorNames: ReadonlyMap<string, string>,
  ): Promise<Result<readonly ProcurementResponse[]>> {
    const request = {
      evaluationId,
      responseGroupId: group.id,
      documentIds: group.documentIds,
    };

    const classifications = await this.classifyResponseGroup.execute(request);
    if (isErr(classifications)) return classifications;

    const financials = await this.extractFinancials.execute(request);
    if (isErr(financials)) return financials;

    const costingByMatch = new Map(
      financials.data.map((row) => [costingKey(row.documentId, row.requirementId), row]),
    );
    // A group always has at least one vendor (makeResponseGroup invariant); fall
    // back to the group label if the vendor row was not found.
    const [primaryVendorId] = group.vendorIds;
    const vendorName =
      (primaryVendorId ? vendorNames.get(primaryVendorId) : undefined) ?? group.label;

    const responses: ProcurementResponse[] = [];
    for (const classification of classifications.data) {
      const response = await this.buildResponse(
        evaluationId,
        group,
        vendorName,
        classification,
        costingByMatch.get(costingKey(classification.documentId, classification.requirementId)),
      );
      if (isErr(response)) return response;
      responses.push(response.data);
    }

    return ok(responses);
  }

  private async buildResponse(
    evaluationId: string,
    group: ResponseGroup,
    vendorName: string,
    classification: RequirementClassification,
    costing: FinancialExtraction | undefined,
  ): Promise<Result<ProcurementResponse>> {
    const passages = await this.passagesFor(evaluationId, classification.documentId);
    if (isErr(passages)) return passages;

    const summary = await this.dependencies.languageModel.summarise({
      vendorName,
      productName: this.dependencies.productName,
      passages: passages.data,
    });
    if (isErr(summary)) return summary;

    return makeProcurementResponse({
      evaluationId,
      responseGroupId: group.id,
      vendorName,
      productName: this.dependencies.productName,
      requirementId: classification.requirementId,
      confidence: classification.confidence,
      productSummary: summary.data,
      costing: costing
        ? { estimateAud: costing.estimateAud, description: costing.description }
        : { estimateAud: null, description: "no costing extracted yet" },
      source: {
        documentId: classification.documentId,
        elementOrder: costing?.elementOrder ?? 0,
        chunkId: classification.sourceChunkId,
      },
    });
  }

  private async passagesFor(
    evaluationId: string,
    documentId: string,
  ): Promise<Result<readonly string[]>> {
    const chunks = await this.dependencies.extractionReader.readChunks(evaluationId, documentId);
    if (isErr(chunks)) return chunks;
    return ok(chunks.data.map((chunk) => chunk.text));
  }
}
