import { ok, err, domainError } from "@redline/redline-domain";
import type {
  Evaluation,
  IEvaluationRepository,
  ProcurementResponse,
  ResponseGroup,
  Vendor,
} from "@redline/redline-domain";

// A minimal in-memory IEvaluationRepository shared across the use-case suites —
// we never mock what we own. It stores the aggregate in maps keyed by
// evaluation, so a use-case can save and read back exactly what it wrote. Lives
// in a `.test-support` file (excluded from the build, carries no `describe`) so
// importing it into several suites does not re-run a test block.
export class InMemoryEvaluationRepository implements IEvaluationRepository {
  readonly evaluations = new Map<string, Evaluation>();
  readonly vendors = new Map<string, Vendor[]>();
  readonly groups = new Map<string, ResponseGroup[]>();
  readonly responses = new Map<string, ProcurementResponse[]>();
  failWith: ReturnType<typeof domainError> | null = null;

  async saveEvaluation(evaluation: Evaluation) {
    if (this.failWith) return err(this.failWith);
    this.evaluations.set(evaluation.id, evaluation);
    return ok(evaluation);
  }

  async findEvaluation(evaluationId: string) {
    if (this.failWith) return err(this.failWith);
    const found = this.evaluations.get(evaluationId);
    return found ? ok(found) : err(domainError("NOT_FOUND", `no evaluation ${evaluationId}`));
  }

  async saveVendor(evaluationId: string, vendor: Vendor) {
    if (this.failWith) return err(this.failWith);
    const list = this.vendors.get(evaluationId) ?? [];
    this.vendors.set(evaluationId, [...list.filter((existing) => existing.id !== vendor.id), vendor]);
    return ok(vendor);
  }

  async listVendors(evaluationId: string) {
    if (this.failWith) return err(this.failWith);
    return ok(this.vendors.get(evaluationId) ?? []);
  }

  async saveResponseGroup(group: ResponseGroup) {
    if (this.failWith) return err(this.failWith);
    const list = this.groups.get(group.evaluationId) ?? [];
    this.groups.set(group.evaluationId, [...list.filter((existing) => existing.id !== group.id), group]);
    return ok(group);
  }

  async listResponseGroups(evaluationId: string) {
    if (this.failWith) return err(this.failWith);
    return ok(this.groups.get(evaluationId) ?? []);
  }

  async saveResponses(responses: readonly ProcurementResponse[]) {
    if (this.failWith) return err(this.failWith);
    for (const response of responses) {
      const list = this.responses.get(response.evaluationId) ?? [];
      this.responses.set(response.evaluationId, [...list, response]);
    }
    return ok(responses);
  }

  async listResponses(evaluationId: string) {
    if (this.failWith) return err(this.failWith);
    return ok(this.responses.get(evaluationId) ?? []);
  }
}
