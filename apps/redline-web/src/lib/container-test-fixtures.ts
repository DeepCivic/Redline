import { ok, err, domainError } from "@redline/redline-domain";
import type {
  Evaluation,
  IEvaluationRepository,
  IProcurementClassifier,
  IFinancialExtractor,
  IProcurementExtractionReader,
  ILanguageModel,
  IStagedCorpusReader,
  IClassificationLensWriter,
  IStagedCorpusWriter,
  IWomblexRunTrigger,
  ProcurementResponse,
  ResponseGroup,
  Result,
  RunStatusView,
  StagedUpload,
  TriggerRunRequest,
  Vendor,
} from "@redline/redline-domain";

// The shared harness the container's two test files both drive: the behaviour
// suite (container.test.ts, WorkflowController end to end) and the wiring suite
// (container-wiring.test.ts, the buildContainer factory over the cold-start and
// money-span paths). Both need the same in-memory repository and the same set of
// satisfies-the-shape port fakes, so they live here rather than being duplicated
// or forcing one oversized file.

// A small in-memory repository so the controller can be exercised end to end
// without a database — the same standalone posture as the application tests.
export class InMemoryRepository implements IEvaluationRepository {
  private evaluations = new Map<string, Evaluation>();
  private vendors = new Map<string, Vendor[]>();
  private groups = new Map<string, ResponseGroup[]>();
  private responses = new Map<string, ProcurementResponse[]>();

  seed(evaluation: Evaluation) {
    this.evaluations.set(evaluation.id, evaluation);
  }

  async saveEvaluation(evaluation: Evaluation) {
    this.evaluations.set(evaluation.id, evaluation);
    return ok(evaluation);
  }
  async findEvaluation(evaluationId: string) {
    const found = this.evaluations.get(evaluationId);
    return found ? ok(found) : err(domainError("NOT_FOUND", `no evaluation ${evaluationId}`));
  }
  async saveVendor(evaluationId: string, vendor: Vendor) {
    const list = this.vendors.get(evaluationId) ?? [];
    this.vendors.set(evaluationId, [...list.filter((v) => v.id !== vendor.id), vendor]);
    return ok(vendor);
  }
  async listVendors(evaluationId: string) {
    return ok(this.vendors.get(evaluationId) ?? []);
  }
  async saveResponseGroup(group: ResponseGroup) {
    const list = this.groups.get(group.evaluationId) ?? [];
    this.groups.set(group.evaluationId, [...list.filter((g) => g.id !== group.id), group]);
    return ok(group);
  }
  async listResponseGroups(evaluationId: string) {
    return ok(this.groups.get(evaluationId) ?? []);
  }
  async saveResponses(responses: readonly ProcurementResponse[]) {
    for (const response of responses) {
      const list = this.responses.get(response.evaluationId) ?? [];
      this.responses.set(response.evaluationId, [...list, response]);
    }
    return ok(responses);
  }
  async listResponses(evaluationId: string) {
    return ok(this.responses.get(evaluationId) ?? []);
  }
  async listEvaluations() {
    return ok([...this.evaluations.values()].reverse());
  }
}

export const classifier: IProcurementClassifier = {
  async classifyResponseGroup(request) {
    return ok(
      request.documentIds.map((documentId) => ({
        documentId,
        requirementId: "req-1",
        confidence: 0.9,
        sourceChunkId: `${documentId}:0`,
        sourceElementOrder: 0,
        unclassified: null,
      })),
    );
  },
};

export const financialExtractor: IFinancialExtractor = {
  async extractFinancials(request) {
    return ok(
      request.documentIds.map((documentId) => ({
        documentId,
        requirementId: "req-1",
        elementOrder: 3,
        estimateAud: 1000,
        description: "",
      })),
    );
  },
};

export const extractionReader: IProcurementExtractionReader = {
  async readElements() {
    return ok([]);
  },
  async readChunks() {
    return ok([{ chunkId: "c-1", documentId: "doc-1", text: "a matched passage" }]);
  },
  async readTableCells() {
    return ok([]);
  },
};

export const languageModel: ILanguageModel = {
  async summarise() {
    return ok("A concise one-paragraph summary.");
  },
};

// The create half's two ports. The reader stands in for the rows the sidecar's
// load path writes, which is the only thing that makes a corpus selectable.
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

export const lensWriter: IClassificationLensWriter = {
  async saveLens() {
    return ok(undefined);
  },
};

// The run half's two write seams. The writer records the bytes it staged; the
// trigger records the runs it fired and hands back a fixed run id. Both are
// exercised in full by create-corpus-controller.test.ts — here they only need to
// satisfy the container's shape so the read/create paths still compose.
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
  async start(request: TriggerRunRequest): Promise<Result<{ readonly runId: string }>> {
    this.started.push(request);
    return ok({ runId: this.nextRunId });
  }
  async status(): Promise<Result<RunStatusView>> {
    return err(domainError("NOT_FOUND", "unused"));
  }
  async resume(runId: string): Promise<Result<{ readonly runId: string }>> {
    return ok({ runId });
  }
}

export const stagedCorpusWriter = new FakeStagedCorpusWriter();
export const runTrigger = new FakeRunTrigger();
