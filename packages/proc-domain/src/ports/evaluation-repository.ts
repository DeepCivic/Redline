import type { Result } from "../result";
import type { Evaluation } from "../entities/evaluation";
import type { ProcurementResponse } from "../entities/procurement-response";
import type { ResponseGroup, Vendor } from "../entities/evaluation-structure";

// Persists the evaluation aggregate and its parts into the proc_ schema
// (Thread 9). All methods return Result — no thrown exceptions cross the port.
export interface IEvaluationRepository {
  saveEvaluation(evaluation: Evaluation): Promise<Result<Evaluation>>;
  findEvaluation(evaluationId: string): Promise<Result<Evaluation>>;

  saveVendor(evaluationId: string, vendor: Vendor): Promise<Result<Vendor>>;
  listVendors(evaluationId: string): Promise<Result<readonly Vendor[]>>;

  saveResponseGroup(group: ResponseGroup): Promise<Result<ResponseGroup>>;
  listResponseGroups(evaluationId: string): Promise<Result<readonly ResponseGroup[]>>;

  saveResponses(
    responses: readonly ProcurementResponse[],
  ): Promise<Result<readonly ProcurementResponse[]>>;
  listResponses(evaluationId: string): Promise<Result<readonly ProcurementResponse[]>>;
}
