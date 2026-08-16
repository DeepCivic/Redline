import { ok, err, domainError } from "@redline/redline-domain";
import type {
  IStagedCorpusReader,
  IStagedCorpusWriter,
  IWomblexRunTrigger,
  Result,
  RunStatusView,
  StagedUpload,
  TriggerRunRequest,
} from "@redline/redline-domain";

// The shared harness container.test.ts drives. The three ports the served
// container carries are faked here rather than inline so the corpus controller's
// suite and any surface test that needs a wired container reach for the same
// shapes.

// The read half. The reader stands in for the rows the sidecar's load path
// writes, which is the only thing that makes a corpus selectable.
export const stagedCorpusReader: IStagedCorpusReader = {
  async listCorpora() {
    return ok([{ corpusId: "tender-2026", documentCount: 2 }]);
  },
  async listDocuments(corpusId: string) {
    if (corpusId !== "tender-2026") {
      return err(domainError("NOT_FOUND", `no corpus staged under ${corpusId}`));
    }
    return ok([
      { documentId: "doc-1", chunkCount: 3, preview: "Response of Acme" },
      { documentId: "doc-2", chunkCount: 5, preview: "Response of Beta" },
    ]);
  },
};

// The two write seams. The writer records the bytes it staged; the trigger
// records the runs it fired and hands back a fixed run id. Both are exercised in
// full by create-corpus-controller.test.ts — here they only need to satisfy the
// container's shape so the read and run paths still compose.
export class FakeStagedCorpusWriter implements IStagedCorpusWriter {
  readonly staged: { evaluationId: string; upload: StagedUpload }[] = [];
  async stage(
    evaluationId: string,
    upload: StagedUpload,
  ): Promise<Result<{ readonly key: string }>> {
    this.staged.push({ evaluationId, upload });
    return ok({ key: `proc/${evaluationId}/inputs/${upload.fileName}` });
  }
}

export class FakeRunTrigger implements IWomblexRunTrigger {
  readonly started: TriggerRunRequest[] = [];
  nextRunId = "run-1";
  nextStatus: RunStatusView | null = null;
  async start(request: TriggerRunRequest): Promise<Result<{ readonly runId: string }>> {
    this.started.push(request);
    return ok({ runId: this.nextRunId });
  }
  async status(): Promise<Result<RunStatusView>> {
    if (this.nextStatus === null) return err(domainError("NOT_FOUND", "no run status staged"));
    return ok(this.nextStatus);
  }
  async resume(runId: string): Promise<Result<{ readonly runId: string }>> {
    return ok({ runId });
  }
}

export const stagedCorpusWriter = new FakeStagedCorpusWriter();
export const runTrigger = new FakeRunTrigger();
