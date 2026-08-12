// @redline/redline-web — the specialist control surface (workflow manager) and
// the in-app review grid (Thread 11+). The workflow-manager core, its container
// wiring, and the view model are framework-free and unit-tested; a thin
// Next.js/React shell binds to them (matching Wayfinder's apps/web — ADR-0006),
// and the Playwright acceptance specs live in the forked Wayfinder
// (services/wayfinder/apps/web/e2e/redline-*.spec.ts, ADR-0019) where they run
// against the served routes.
export {
  WorkflowManager,
  type WorkflowManagerInit,
  type WorkflowManagerGroup,
  type WorkflowManagerVendor,
  type WorkflowSnapshot,
} from "./lib/workflow-manager";

export {
  WorkflowController,
  buildContainer,
  buildColdStartClassifier,
  type OpenWorkflowInput,
  type ProductionContainerParts,
  type ColdStartClassifierParts,
  type WorkflowContainer,
} from "./lib/container";

export {
  renderWorkflowView,
  type GroupView,
  type WorkflowView,
} from "./lib/view";

export {
  ReviewGrid,
  REVIEW_COLUMNS,
  type ReviewColumn,
  type ReviewColumnKey,
  type ReviewColumnType,
  type ReviewCell,
  type ReviewRow,
  type ReviewSort,
  type ReviewFilter,
  type ReviewSourceLink,
  type SortDirection,
} from "./lib/review-grid";

export {
  renderReviewGridView,
  type RenderReviewGridInput,
  type ReviewGridView,
  type ReviewHeaderView,
  type ReviewRowView,
  type ReviewCellView,
} from "./lib/review-view";

export {
  renderRunStatusView,
  type RunStatusViewModel,
} from "./lib/run-status-view";

export {
  RunStatusController,
  type RunStatusControllerParts,
} from "./lib/run-status-controller";

export {
  renderDocumentView,
  documentElementDomId,
  type RenderDocumentViewInput,
  type DocumentView,
  type DocumentElementView,
} from "./lib/document-view";

export {
  PricingPivot,
  PIVOT_AXES,
  type PivotAxis,
  type PivotMeasureKind,
  type PivotRequest,
  type PivotCell,
  type PivotRow,
  type PricingPivotResult,
} from "./lib/pricing-pivot";

export {
  renderPivotView,
  type RenderPivotInput,
  type PivotTableView,
  type PivotTableRow,
  type PivotTableCell,
} from "./lib/pricing-view";

export {
  buildReviewSheetData,
  buildPivotSheetData,
  buildEvaluationWorkbook,
  evaluationExportFileName,
  exportEvaluationXlsx,
  toWriterSheets,
  writeEvaluationWorkbook,
  type SheetCell,
  type SheetData,
  type EvaluationWorkbook,
  type EvaluationWorkbookInput,
  type PivotSheetInput,
  type ExportEvaluationInput,
  type WriteEvaluationWorkbookInput,
} from "./lib/excel-export";

export {
  buildReportSheetData,
  buildReportWorkbook,
  REPORT_SHEET_NAME,
  type AssembledReport,
  type ReportSection,
  type TransferredPassage,
  type ReportFinancialExpression,
} from "./lib/report-export";
