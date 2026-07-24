import {
  domainError,
  err,
  isErr,
  makeEvaluation,
  ok,
  withIntakeStage,
  type Evaluation,
  type IEvaluationRepository,
  type IProcurementExtractionReader,
  type Result,
} from "@redline/redline-domain";

// IngestDocuments — the first orchestration step (build plan §5, stage
// documents_uploaded → grouping). womblex extraction has already run (the
// sidecar wrote its shards); this use-case confirms every document reads back
// through the extraction port, persists the evaluation, and advances the stage.
// It does not trigger womblex itself — that is the sidecar's job (Thread 3).
export interface IngestDocumentsDependencies {
  readonly repository: IEvaluationRepository;
  readonly extractionReader: IProcurementExtractionReader;
}

export interface IngestDocumentsInput {
  readonly evaluationId: string;
  readonly evaluationName: string;
  readonly documentIds: readonly string[];
}

export class IngestDocuments {
  constructor(private readonly dependencies: IngestDocumentsDependencies) {}

  async execute(input: IngestDocumentsInput): Promise<Result<Evaluation>> {
    if (input.documentIds.length === 0) {
      return err(domainError("VALIDATION_FAILED", "ingest needs at least one document"));
    }

    const evaluation = makeEvaluation({
      id: input.evaluationId,
      name: input.evaluationName,
      stage: "documents_uploaded",
    });
    if (isErr(evaluation)) return evaluation;

    for (const documentId of input.documentIds) {
      const elements = await this.dependencies.extractionReader.readElements(
        input.evaluationId,
        documentId,
      );
      if (isErr(elements)) {
        return err(
          domainError(
            "EXTRACTION_FAILED",
            `document ${documentId} has no readable extraction: ${elements.error.message}`,
            elements.error,
          ),
        );
      }
    }

    const grouping = withIntakeStage(evaluation.data, "grouping");
    if (isErr(grouping)) return grouping;

    const saved = await this.dependencies.repository.saveEvaluation(grouping.data);
    if (isErr(saved)) return saved;

    return ok(saved.data);
  }
}
