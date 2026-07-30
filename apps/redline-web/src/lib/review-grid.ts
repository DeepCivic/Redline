import type { ProcurementResponse } from "@redline/redline-domain";

// ReviewGrid — the specialist review surface's brain (build plan §1 / §5).
// A pure, framework-free model of the sortable, filterable review
// table: it turns the BuildEvaluationTable output (one ProcurementResponse per
// (group, document, matched requirement)) into typed, sortable rows a Next.js/
// React shell binds to. Currency stays a real number end-to-end (the domain
// already carries estimateAud: number | null — Thread 8/10), so it sorts
// numerically and exports numeric; the exit test pins that against
// Wayfinder's typedDisplayCell, matching the Thread 8 adapter's posture. The
// source column carries provenance for a deep-link to the exact document
// location. Holds no ports; the container hands it the already-built responses.

// The grid's columns, in display order (build plan §1 "per response, capture").
// The `type` picks how a cell is rendered/sorted/exported — `currency`/`number`
// route through the numeric path, everything else is text.
export type ReviewColumnKey =
  | "vendorName"
  | "productName"
  | "requirementId"
  | "confidence"
  | "productSummary"
  | "estimateAud"
  | "costDescription"
  | "source";

export type ReviewColumnType = "text" | "currency" | "number";

export interface ReviewColumn {
  readonly key: ReviewColumnKey;
  readonly label: string;
  readonly type: ReviewColumnType;
  readonly sortable: boolean;
}

// The ordered column set. Only the source column is unsortable — it is a
// provenance link, not a comparable value.
export const REVIEW_COLUMNS: readonly ReviewColumn[] = [
  { key: "vendorName", label: "Vendor", type: "text", sortable: true },
  { key: "productName", label: "Product", type: "text", sortable: true },
  { key: "requirementId", label: "Requirement", type: "text", sortable: true },
  { key: "confidence", label: "Confidence", type: "number", sortable: true },
  { key: "productSummary", label: "Summary", type: "text", sortable: true },
  { key: "estimateAud", label: "Estimate (AUD)", type: "currency", sortable: true },
  { key: "costDescription", label: "Costing", type: "text", sortable: true },
  { key: "source", label: "Source", type: "text", sortable: false },
];

// A resolved cell: `display` is what the DOM shows, `sortValue` is what a sort
// compares (numeric for currency/number, lowercased string otherwise), and
// `isNumeric` is true for a parseable currency/number cell so the shell can
// right-align / the export can write a real numeric cell.
export interface ReviewCell {
  readonly display: string;
  readonly sortValue: number | string;
  readonly isNumeric: boolean;
}

// Provenance for the source column's deep-link to the exact document location
// (build plan §5). `documentId` = womblex source_hash; `chunkId` =
// "{source_hash}:{chunk_index}" when the roll-up carried one.
export interface ReviewSourceLink {
  readonly documentId: string;
  readonly elementOrder: number;
  readonly page: number | null;
  readonly chunkId: string | null;
  readonly label: string;
}

export interface ReviewRow {
  readonly id: string;
  readonly cells: Readonly<Record<ReviewColumnKey, ReviewCell>>;
  readonly source: ReviewSourceLink;
}

export type SortDirection = "asc" | "desc";

export interface ReviewSort {
  readonly key: ReviewColumnKey;
  readonly direction: SortDirection;
}

export interface ReviewFilter {
  // Free-text filter matched (case-insensitive) against every text/number/
  // currency cell's display string.
  readonly query?: string;
  // Restrict to a single requirement (the most common review lens).
  readonly requirementId?: string;
}

const currencyDisplay = (estimateAud: number | null): string => {
  if (estimateAud === null) return "";
  return estimateAud.toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
  });
};

const sourceLabel = (response: ProcurementResponse): string => {
  const page = response.source.page;
  const wherePage = page === null ? "" : ` · p.${page}`;
  return `${response.source.documentId}${wherePage}`;
};

const textCell = (raw: string): ReviewCell => ({
  display: raw,
  sortValue: raw.toLowerCase(),
  isNumeric: false,
});

const numberCell = (value: number): ReviewCell => {
  const raw = String(value);
  const isNumeric = Number.isFinite(value);
  return {
    display: raw,
    sortValue: isNumeric ? value : raw.toLowerCase(),
    isNumeric,
  };
};

const currencyCell = (estimateAud: number | null): ReviewCell => {
  if (estimateAud === null) {
    // A null estimate is the description-fallback signal. It sorts
    // as the lowest number so all "no figure" rows cluster together, and is
    // never marked numeric (there is no figure to right-align or export).
    return { display: "", sortValue: Number.NEGATIVE_INFINITY, isNumeric: false };
  }
  // The domain already carries a real number, so the sort key is
  // the figure itself — a numeric sort, not a lexical one.
  return {
    display: currencyDisplay(estimateAud),
    sortValue: estimateAud,
    isNumeric: Number.isFinite(estimateAud),
  };
};

// One ProcurementResponse → one typed grid row. The row id is the natural key of
// the review unit: (group, document, requirement).
const toRow = (response: ProcurementResponse): ReviewRow => ({
  id: `${response.responseGroupId}::${response.source.documentId}::${response.requirementId}`,
  cells: {
    vendorName: textCell(response.vendorName),
    productName: textCell(response.productName),
    requirementId: textCell(response.requirementId),
    confidence: numberCell(response.confidence),
    productSummary: textCell(response.productSummary),
    estimateAud: currencyCell(response.costing.estimateAud),
    costDescription: textCell(response.costing.description),
    source: {
      display: sourceLabel(response),
      sortValue: sourceLabel(response).toLowerCase(),
      isNumeric: false,
    },
  },
  source: {
    documentId: response.source.documentId,
    elementOrder: response.source.elementOrder,
    page: response.source.page,
    chunkId: response.source.chunkId,
    label: sourceLabel(response),
  },
});

const compareCells = (a: ReviewCell, b: ReviewCell): number => {
  if (typeof a.sortValue === "number" && typeof b.sortValue === "number") {
    return a.sortValue - b.sortValue;
  }
  return String(a.sortValue).localeCompare(String(b.sortValue));
};

const matchesFilter = (row: ReviewRow, filter: ReviewFilter): boolean => {
  if (filter.requirementId && row.cells.requirementId.display !== filter.requirementId) {
    return false;
  }
  const query = filter.query?.trim().toLowerCase();
  if (!query) return true;
  return REVIEW_COLUMNS.some((column) => row.cells[column.key].display.toLowerCase().includes(query));
};

export class ReviewGrid {
  private readonly rows: readonly ReviewRow[];

  constructor(responses: readonly ProcurementResponse[]) {
    this.rows = responses.map(toRow);
  }

  // All rows in build order — the default (unsorted, unfiltered) view.
  all(): readonly ReviewRow[] {
    return this.rows;
  }

  // Distinct requirement ids in first-seen order, for a filter dropdown.
  requirementIds(): readonly string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const row of this.rows) {
      const id = row.cells.requirementId.display;
      if (!seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    return ordered;
  }

  // Sorted + filtered rows the shell renders. Stable: equal keys keep their
  // build order. Currency/number columns sort numerically (the whole point of
  // reusing `typedDisplayCell` — the exit criterion).
  view(options: { readonly sort?: ReviewSort; readonly filter?: ReviewFilter } = {}): readonly ReviewRow[] {
    const filter = options.filter ?? {};
    const filtered = this.rows.filter((row) => matchesFilter(row, filter));

    const sort = options.sort;
    if (!sort) return filtered;

    const column = REVIEW_COLUMNS.find((candidate) => candidate.key === sort.key);
    if (!column || !column.sortable) return filtered;

    const decorated = filtered.map((row, index) => ({ row, index }));
    decorated.sort((left, right) => {
      const primary = compareCells(left.row.cells[sort.key], right.row.cells[sort.key]);
      const ordered = sort.direction === "desc" ? -primary : primary;
      // Stable: fall back to build order so a re-sort is deterministic.
      return ordered !== 0 ? ordered : left.index - right.index;
    });
    return decorated.map((entry) => entry.row);
  }
}
