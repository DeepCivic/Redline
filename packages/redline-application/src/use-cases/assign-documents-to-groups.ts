import {
  domainError,
  err,
  isErr,
  makeResponseGroup,
  makeVendor,
  ok,
  withIntakeStage,
  type Evaluation,
  type IEvaluationRepository,
  type Result,
} from "@redline/redline-domain";

// AssignDocumentsToGroups — the specialist's grouping step (build plan §5, stage
// grouping → classifying). Persists the vendors and the response groups (docs →
// group, consortium detection lives in makeResponseGroup) and advances the
// stage. A group may only reference vendors declared in the same call, so the
// composition is internally consistent before classification runs.
export interface AssignDocumentsToGroupsDependencies {
  readonly repository: IEvaluationRepository;
}

export interface VendorInput {
  readonly id: string;
  readonly displayName: string;
  readonly isConsortium?: boolean;
  readonly memberVendorIds?: readonly string[];
}

export interface ResponseGroupInput {
  readonly id: string;
  readonly vendorIds: readonly string[];
  readonly label: string;
  readonly documentIds: readonly string[];
}

export interface AssignDocumentsToGroupsInput {
  readonly evaluationId: string;
  readonly vendors: readonly VendorInput[];
  readonly groups: readonly ResponseGroupInput[];
}

export class AssignDocumentsToGroups {
  constructor(private readonly dependencies: AssignDocumentsToGroupsDependencies) {}

  async execute(input: AssignDocumentsToGroupsInput): Promise<Result<Evaluation>> {
    const evaluation = await this.dependencies.repository.findEvaluation(input.evaluationId);
    if (isErr(evaluation)) return evaluation;

    const classifying = withIntakeStage(evaluation.data, "classifying");
    if (isErr(classifying)) return classifying;

    const knownVendorIds = new Set(input.vendors.map((vendor) => vendor.id));
    for (const group of input.groups) {
      const unknown = group.vendorIds.find((vendorId) => !knownVendorIds.has(vendorId));
      if (unknown) {
        return err(
          domainError(
            "VALIDATION_FAILED",
            `group ${group.id} references unknown vendor ${unknown}`,
          ),
        );
      }
    }

    for (const vendorInput of input.vendors) {
      const vendor = makeVendor(vendorInput);
      if (isErr(vendor)) return vendor;
      const saved = await this.dependencies.repository.saveVendor(input.evaluationId, vendor.data);
      if (isErr(saved)) return saved;
    }

    for (const groupInput of input.groups) {
      const group = makeResponseGroup({ evaluationId: input.evaluationId, ...groupInput });
      if (isErr(group)) return group;
      const saved = await this.dependencies.repository.saveResponseGroup(group.data);
      if (isErr(saved)) return saved;
    }

    const saved = await this.dependencies.repository.saveEvaluation(classifying.data);
    if (isErr(saved)) return saved;

    return ok(saved.data);
  }
}
