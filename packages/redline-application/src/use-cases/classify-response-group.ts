import type {
  ClassificationRequest,
  IProcurementClassifier,
  RequirementClassification,
  Result,
} from "@redline/redline-domain";

// ClassifyResponseGroup — run Numbatch over one response group and return the
// per-(document, requirement) roll-ups. A thin use-case: the topic→requirement
// mapping and batch polling live in the adapter; the application
// layer just names the step so a UI can (re)run classification per
// group and BuildEvaluationTable can compose over it.
export interface ClassifyResponseGroupDependencies {
  readonly classifier: IProcurementClassifier;
}

export class ClassifyResponseGroup {
  constructor(private readonly dependencies: ClassifyResponseGroupDependencies) {}

  execute(
    request: ClassificationRequest,
  ): Promise<Result<readonly RequirementClassification[]>> {
    return this.dependencies.classifier.classifyResponseGroup(request);
  }
}
