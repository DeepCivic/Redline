import { domainError } from "../errors/domain-error";
import { err, ok, type Result } from "../result";
import { canAdvanceIntakeStage, type IntakeStage } from "./evaluation-structure";

// The evaluation aggregate root: the unit a specialist runs end to end. It owns
// the intake stage; vendors, response groups and responses hang off it by
// evaluationId. Persisted via IEvaluationRepository (Thread 9).
export interface Evaluation {
  readonly id: string;
  readonly name: string;
  readonly stage: IntakeStage;
}

export interface MakeEvaluationInput {
  readonly id: string;
  readonly name: string;
  readonly stage?: IntakeStage;
}

export const makeEvaluation = (input: MakeEvaluationInput): Result<Evaluation> => {
  const name = input.name.trim();
  if (name === "") {
    return err(domainError("VALIDATION_FAILED", "evaluation name must not be blank"));
  }

  return ok({ id: input.id, name, stage: input.stage ?? "documents_uploaded" });
};

export const withIntakeStage = (
  evaluation: Evaluation,
  stage: IntakeStage,
): Result<Evaluation> => {
  if (!canAdvanceIntakeStage(evaluation.stage, stage)) {
    return err(
      domainError(
        "VALIDATION_FAILED",
        `cannot advance intake stage from ${evaluation.stage} to ${stage}`,
      ),
    );
  }

  return ok({ ...evaluation, stage });
};
