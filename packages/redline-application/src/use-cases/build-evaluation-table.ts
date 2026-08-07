import {
  domainError,
  err,
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
//   • a one-paragraph AI summary over *that topic's* evidence passages,
// into one ProcurementResponse per (group, document, matched requirement) — the
// review grid's natural row (build plan §5) — persists them, and advances the
// stage to `review`. Currency stays a real number end-to-end (ADR).
//
// A document that matched nothing still becomes one visible row (a grid is rows,
// so an unmatched document is invisible unless it carries one). It is labelled
// unclassified and its summary states which of the two reasons applies — the
// vendor answered nothing we asked, or we never read the file — so a specialist
// can act on the distinction the classifier drew.
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

// The requirement label a document with no match carries in the grid, so the row
// is visible rather than dropped. A specialist filters on it to find the
// documents that need a human look.
const UNCLASSIFIED_REQUIREMENT = "(unclassified)";

// What the unclassified row's summary tells the specialist — the two reasons
// mean different things and must read differently.
const UNCLASSIFIED_SUMMARY: Readonly<Record<NonNullable<RequirementClassification["unclassified"]>, string>> = {
  addressed_nothing: "This document was read but addressed none of the requirements in the lens.",
  no_extraction: "This document has no extraction on record — it was never read.",
};

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

    // The money-span extractor attributes a document's spans to the requirement
    // it matched; the Numbatch extractor ignores this field. Passing it keeps the
    // real extractor's attribution rule fed while staying interchangeable. An
    // unclassified row has no requirement to attribute money to, so it is left
    // out of the matched set.
    const financials = await this.extractFinancials.execute({
      ...request,
      matchedRequirements: classifications.data.flatMap((classification) =>
        classification.requirementId === null
          ? []
          : [
              {
                documentId: classification.documentId,
                requirementId: classification.requirementId,
                confidence: classification.confidence,
              },
            ],
      ),
    });
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
      const costing =
        classification.requirementId === null
          ? undefined
          : costingByMatch.get(
              costingKey(classification.documentId, classification.requirementId),
            );
      const response = await this.buildResponse(
        evaluationId,
        group,
        vendorName,
        classification,
        costing,
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
    if (classification.unclassified !== null) {
      return this.buildUnclassifiedResponse(
        evaluationId,
        group,
        vendorName,
        classification,
        classification.unclassified,
      );
    }

    const requirementId = classification.requirementId;
    // A classified row always names a requirement; a null here is a producer
    // that set neither field and is a bug, not a row to render blank.
    if (requirementId === null) {
      return err(
        domainError(
          "VALIDATION_FAILED",
          `classification for document '${classification.documentId}' has no requirement and no unclassified reason`,
        ),
      );
    }

    // Summarise over *this topic's* evidence passage rather than the whole
    // document, so each of a vendor's rows describes the answer it classified —
    // not the identical opening paragraph on every row.
    const passages = await this.passagesFor(
      evaluationId,
      classification.documentId,
      classification.sourceChunkId,
    );
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
      requirementId,
      confidence: classification.confidence,
      productSummary: summary.data,
      costing: costing
        ? { estimateAud: costing.estimateAud, description: costing.description }
        : { estimateAud: null, description: "no costing extracted yet" },
      source: {
        documentId: classification.documentId,
        // The element the evidence chunk came from, so the deep-link lands on the
        // passage that placed the topic. The costing's element is the fallback,
        // and element 0 the last resort when neither is known.
        elementOrder: classification.sourceElementOrder ?? costing?.elementOrder ?? 0,
        chunkId: classification.sourceChunkId,
      },
    });
  }

  // A document that matched no requirement, rendered as one visible row rather
  // than dropped. No model call and no costing: there is no matched passage to
  // summarise and no requirement to attribute money to — the summary is the
  // reason itself, which is the actionable content for the specialist.
  private buildUnclassifiedResponse(
    evaluationId: string,
    group: ResponseGroup,
    vendorName: string,
    classification: RequirementClassification,
    reason: NonNullable<RequirementClassification["unclassified"]>,
  ): Result<ProcurementResponse> {
    return makeProcurementResponse({
      evaluationId,
      responseGroupId: group.id,
      vendorName,
      productName: this.dependencies.productName,
      requirementId: UNCLASSIFIED_REQUIREMENT,
      confidence: classification.confidence,
      productSummary: UNCLASSIFIED_SUMMARY[reason],
      costing: { estimateAud: null, description: "not applicable — unclassified" },
      source: {
        documentId: classification.documentId,
        elementOrder: 0,
        chunkId: null,
      },
    });
  }

  // The passages the summary reads for one row. When the classification cited an
  // evidence chunk, only that chunk's text is summarised, so the row describes
  // the topic it matched. Absent a citation (paths with no per-chunk provenance),
  // the whole document is summarised as before.
  private async passagesFor(
    evaluationId: string,
    documentId: string,
    evidenceChunkId: string | null,
  ): Promise<Result<readonly string[]>> {
    const chunks = await this.dependencies.extractionReader.readChunks(evaluationId, documentId);
    if (isErr(chunks)) return chunks;

    if (evidenceChunkId === null) {
      return ok(chunks.data.map((chunk) => chunk.text));
    }

    const evidence = chunks.data.filter((chunk) => chunk.chunkId === evidenceChunkId);
    // A cited chunk the reader no longer carries falls back to the whole
    // document rather than summarising nothing.
    const selected = evidence.length > 0 ? evidence : chunks.data;
    return ok(selected.map((chunk) => chunk.text));
  }
}
