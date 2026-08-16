// @redline/redline-web — the corpus control surface. A specialist names a run,
// uploads its documents, authors the config, fires the run and watches it drain;
// what the run lands is then read by apps/redline-mcp's report tools and shaped
// into a sheet here. The controllers and view models are framework-free and
// unit-tested; a thin Next.js/React shell binds to them (matching Wayfinder's
// apps/web), and the Playwright acceptance specs live in the forked Wayfinder
// (services/wayfinder/apps/web/e2e/redline-*.spec.ts) where they run against the
// served routes.
export { CorpusController, type CorpusContainer } from "./lib/container";

export { renderRunStatusView, type RunStatusViewModel } from "./lib/run-status-view";

export { RunStatusController, type RunStatusControllerParts } from "./lib/run-status-controller";

export {
  CreateCorpusController,
  type CreateCorpusControllerParts,
  type CreateCorpusInput,
  type CreateCorpusResult,
  type StageDocumentInput,
  type StartRunInput,
} from "./lib/create-corpus-controller";

export {
  renderCreateCorpusView,
  AUTHORABLE_STAGES,
  DEFAULT_STAGE_SEQUENCE,
  type CreateCorpusDraft,
  type CreateCorpusView,
  type PendingUpload,
  type UploadRowView,
  type StageToggleView,
  type ChunkModeView,
  type MoneyVocabularyView,
  type ExtractionView,
} from "./lib/create-corpus-view";

export {
  buildReportSheetData,
  buildReportWorkbook,
  toWriterSheets,
  reportExportFileName,
  writeReportWorkbook,
  REPORT_SHEET_NAME,
  type AssembledReport,
  type ReportSection,
  type ReportWorkbook,
  type SheetCell,
  type SheetData,
  type TransferredPassage,
  type ReportFinancialExpression,
  type WriteReportWorkbookInput,
} from "./lib/report-export";
