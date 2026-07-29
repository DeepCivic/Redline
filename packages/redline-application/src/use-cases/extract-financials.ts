import type {
  FinancialExtraction,
  FinancialExtractionRequest,
  IFinancialExtractor,
  Result,
} from "@redline/redline-domain";

// ExtractFinancials — pull the currency figures (or description fallback) the
// Numbatch financial worker wrote for one response group's documents.
// A thin use-case mirroring ClassifyResponseGroup so the orchestration and a UI
// name the step; the read seam + topic→requirement mapping live in the adapter
//.
export interface ExtractFinancialsDependencies {
  readonly financialExtractor: IFinancialExtractor;
}

export class ExtractFinancials {
  constructor(private readonly dependencies: ExtractFinancialsDependencies) {}

  execute(
    request: FinancialExtractionRequest,
  ): Promise<Result<readonly FinancialExtraction[]>> {
    return this.dependencies.financialExtractor.extractFinancials(request);
  }
}
