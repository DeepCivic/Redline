import type { Result } from "../result";

// Triggers a womblex run over a corpus's staged documents. The returned
// runId is the run-scoping key every corpus-read port takes (§8 blocker 1) —
// distinct from ReportRun.runId (report/types.ts), which identifies the
// per-document extraction loop, not the womblex engine run that feeds it.

export interface IWomblexRunTrigger {
  trigger(corpusId: string, documentIds: readonly string[]): Promise<Result<{ readonly runId: string }>>;
}
