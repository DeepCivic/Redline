import {
  REVIEW_COLUMNS,
  ReviewGrid,
  type ReviewColumn,
  type ReviewFilter,
  type ReviewRow,
  type ReviewSort,
} from "./review-grid";

// View model for the in-app review grid (Thread 12). A pure transform of a
// ReviewGrid into presentation-ready shapes the Next.js/React shell binds to —
// header cells (with the active sort indicator + next-click direction), the
// sorted/filtered body rows, and a resolved source deep-link href per row.
// Keeps the DOM dumb and the sort/filter/link logic tested without a browser,
// matching the workflow-manager's view.ts (ADR-0006).

export interface ReviewHeaderView {
  readonly key: ReviewColumn["key"];
  readonly label: string;
  readonly sortable: boolean;
  // "asc" | "desc" when this column is the active sort, else null.
  readonly activeDirection: ReviewSort["direction"] | null;
  // The direction a click should apply next (toggles on the active column,
  // defaults to ascending otherwise). null when the column is not sortable.
  readonly nextDirection: ReviewSort["direction"] | null;
}

export interface ReviewCellView {
  readonly display: string;
  readonly isNumeric: boolean;
}

export interface ReviewRowView {
  readonly id: string;
  readonly cells: readonly ReviewCellView[];
  readonly source: {
    readonly label: string;
    // A deep-link the shell renders as an <a href>; resolves to the document
    // location (page/element/chunk provenance — build plan §5).
    readonly href: string;
  };
}

export interface ReviewGridView {
  readonly headers: readonly ReviewHeaderView[];
  readonly rows: readonly ReviewRowView[];
  readonly requirementFilterOptions: readonly string[];
  readonly rowCount: number;
  readonly isEmpty: boolean;
}

export interface RenderReviewGridInput {
  readonly evaluationId: string;
  readonly grid: ReviewGrid;
  readonly sort?: ReviewSort;
  readonly filter?: ReviewFilter;
}

// The source deep-link. Points at the evaluation's document view, anchored to
// the exact element (and chunk, when the roll-up carried one). The shell / route
// layer owns the concrete URL space; this is the stable contract Thread 12 +
// the e2e pin.
const sourceHref = (evaluationId: string, row: ReviewRow): string => {
  const params = new URLSearchParams({ element: String(row.source.elementOrder) });
  if (row.source.page !== null) params.set("page", String(row.source.page));
  if (row.source.chunkId !== null) params.set("chunk", row.source.chunkId);
  return `/evaluations/${evaluationId}/documents/${row.source.documentId}?${params.toString()}`;
};

const headerView = (column: ReviewColumn, sort: ReviewSort | undefined): ReviewHeaderView => {
  const active = sort && sort.key === column.key ? sort.direction : null;
  const nextDirection = !column.sortable
    ? null
    : active === "asc"
      ? "desc"
      : "asc";
  return {
    key: column.key,
    label: column.label,
    sortable: column.sortable,
    activeDirection: active,
    nextDirection,
  };
};

export const renderReviewGridView = (input: RenderReviewGridInput): ReviewGridView => {
  const rows = input.grid.view({ sort: input.sort, filter: input.filter });

  return {
    headers: REVIEW_COLUMNS.map((column) => headerView(column, input.sort)),
    rows: rows.map((row) => ({
      id: row.id,
      cells: REVIEW_COLUMNS.map((column) => ({
        display: row.cells[column.key].display,
        isNumeric: row.cells[column.key].isNumeric,
      })),
      source: {
        label: row.source.label,
        href: sourceHref(input.evaluationId, row),
      },
    })),
    requirementFilterOptions: input.grid.requirementIds(),
    rowCount: rows.length,
    isEmpty: rows.length === 0,
  };
};
