import type { Result } from "../result";
import type { Evaluation } from "../entities/evaluation";
import type { ProcurementResponse } from "../entities/procurement-response";
import type { ResponseGroup, Vendor } from "../entities/evaluation-structure";

// Persists the evaluation aggregate and its parts into the redline_ schema
//. All methods return Result — no thrown exceptions cross the port.
export interface IEvaluationRepository {
  saveEvaluation(evaluation: Evaluation): Promise<Result<Evaluation>>;
  findEvaluation(evaluationId: string): Promise<Result<Evaluation>>;
  // Every evaluation in the store, newest first — the order the /evaluations
  // index lists them in, so a specialist's most recent run is the first thing
  // they see. Unscoped by design: redline has no per-evaluation ownership model,
  // and access is gated at the served route by `evaluation:review`.
  listEvaluations(): Promise<Result<readonly Evaluation[]>>;

  saveVendor(evaluationId: string, vendor: Vendor): Promise<Result<Vendor>>;
  listVendors(evaluationId: string): Promise<Result<readonly Vendor[]>>;

  saveResponseGroup(group: ResponseGroup): Promise<Result<ResponseGroup>>;
  listResponseGroups(evaluationId: string): Promise<Result<readonly ResponseGroup[]>>;

  saveResponses(
    responses: readonly ProcurementResponse[],
  ): Promise<Result<readonly ProcurementResponse[]>>;
  listResponses(evaluationId: string): Promise<Result<readonly ProcurementResponse[]>>;
}
