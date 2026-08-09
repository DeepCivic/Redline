import {
  isErr,
  ok,
  type FinancialExtraction,
  type FinancialExtractionRequest,
  type IFinancialExtractor,
  type IMoneySpanStore,
  type MatchedRequirement,
  type MoneySpanRow,
  type Result,
} from "@redline/redline-domain";
import { readDocumentMoney } from "./money-span-reading";

// MoneySpanFinancialExtractor — the real IFinancialExtractor. It reads womblex's
// addressable money spans (IMoneySpanStore, materialised from
// `*.money_spans.parquet` — ADR-0017) and turns them into the (documentId,
// requirementId) costing the review grid needs. This is where AUD reaches the grid.
//
// A span is an anchored financial expression — it has no requirement, and nothing
// below this seam attaches one. **This extractor owns that attribution for the
// grid**, and says so rather than deferring to a report assembler that will make its
// own, different reading over the same rows through the MCP tool surface. The rule:
// a document's spans attach to the ONE requirement its classification matched with
// the highest confidence, ties broken on the lexicographically-least requirementId.
// A document's money lands once on that single row, so a document matching more than
// one requirement never duplicates itself into the per-brand pivot totals.
//
// What each span *contributes* is `readDocumentMoney`'s decision, not this file's:
// narrative amounts give way to a pricing table, a range counts once at its upper
// endpoint, and a qualified amount is reported as a bound instead of an exact
// figure. This class only picks the requirement and shapes the port's row.

export interface MoneySpanFinancialExtractorDependencies {
  readonly moneySpanStore: IMoneySpanStore;
}

const bestRequirementFor = (
  documentId: string,
  matches: readonly MatchedRequirement[],
): string | null => {
  let best: MatchedRequirement | null = null;
  for (const match of matches) {
    if (match.documentId !== documentId) continue;
    if (best === null) {
      best = match;
      continue;
    }
    if (match.confidence > best.confidence) {
      best = match;
      continue;
    }
    if (match.confidence === best.confidence && match.requirementId < best.requirementId) {
      best = match;
    }
  }
  return best === null ? null : best.requirementId;
};

export class MoneySpanFinancialExtractor implements IFinancialExtractor {
  constructor(private readonly dependencies: MoneySpanFinancialExtractorDependencies) {}

  async extractFinancials(
    request: FinancialExtractionRequest,
  ): Promise<Result<readonly FinancialExtraction[]>> {
    const matches = request.matchedRequirements ?? [];
    const rows: FinancialExtraction[] = [];

    for (const documentId of request.documentIds) {
      const requirementId = bestRequirementFor(documentId, matches);
      if (requirementId === null) continue;

      const spans = await this.dependencies.moneySpanStore.fetchByDocument(
        request.evaluationId,
        documentId,
      );
      if (isErr(spans)) return spans;
      if (spans.data.length === 0) continue;

      rows.push(this.attribute(documentId, requirementId, spans.data));
    }

    return ok(rows);
  }

  private attribute(
    documentId: string,
    requirementId: string,
    spans: readonly MoneySpanRow[],
  ): FinancialExtraction {
    const reading = readDocumentMoney(spans);
    const [firstCountedSpan] = reading.countedSpans;
    return {
      documentId,
      requirementId,
      // The anchor comes from a span the figure actually counted, so the grid's
      // source deep-link lands on money that is in the total. Only a cell span
      // carries an element anchor; a narrative span is addressed by character
      // offsets, so it has none to give the grid.
      elementOrder: firstCountedSpan?.parentElementOrder ?? firstCountedSpan?.elementOrder ?? 0,
      estimateAud: reading.estimateAud,
      description: reading.description,
    };
  }
}
