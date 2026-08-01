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

// MoneySpanFinancialExtractor — the real IFinancialExtractor. It reads womblex's
// addressable money spans (IMoneySpanStore, materialised from
// `*.money_spans.parquet` — ADR-0017) and turns them into the (documentId,
// requirementId) costing the review grid needs. This is where AUD reaches the grid.
//
// A span is (document, table, row, col) — it has no requirement. The interim
// attribution rule (delivery-plan §2 item 1): a document's spans attach to the
// ONE requirement its classification matched with the highest confidence, ties
// broken on the lexicographically-least requirementId. A document's spans are
// summed once onto that single row, so a document matching more than one
// requirement never duplicates its money into the per-brand pivot totals.
//
// Amounts are summed in fixed-point (scaled integers) not float: womblex writes
// `decimal128(38,4)` precisely because summing many amounts accumulates float
// error. The Number coercion for `estimateAud` happens once, at the boundary.

export interface MoneySpanFinancialExtractorDependencies {
  readonly moneySpanStore: IMoneySpanStore;
}

const DECIMAL_SCALE = 4n;
const SCALE_FACTOR = 10n ** DECIMAL_SCALE;

// Parse an exact decimal string ("1500.5000") to a scaled BigInt (15005000),
// so a run of amounts sums without float drift. Negative and shorter/longer
// fraction widths are tolerated; the value is rescaled to four places.
const toScaledInteger = (value: string): bigint => {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const paddedFraction = (fraction + "0000").slice(0, 4);
  const magnitude = BigInt(whole || "0") * SCALE_FACTOR + BigInt(paddedFraction || "0");
  return negative ? -magnitude : magnitude;
};

// The scaled total back to a real number, once, at the port boundary.
const scaledToNumber = (scaled: bigint): number => Number(scaled) / Number(SCALE_FACTOR);

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

const summariseSpans = (spans: readonly MoneySpanRow[], total: number): string => {
  const currencies = new Set(
    spans.map((span) => span.currency).filter((currency): currency is string => currency !== null),
  );
  const currencyLabel = currencies.size === 1 ? [...currencies][0] : "mixed currency";
  return `${spans.length} priced rows totalling ${total} ${currencyLabel}`;
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
    const scaledTotal = spans.reduce((sum, span) => sum + toScaledInteger(span.value), 0n);
    const estimateAud = scaledToNumber(scaledTotal);
    const [firstSpan] = spans;
    return {
      documentId,
      requirementId,
      elementOrder: firstSpan!.parentElementOrder,
      estimateAud,
      description: summariseSpans(spans, estimateAud),
    };
  }
}
