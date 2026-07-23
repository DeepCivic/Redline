import { domainError } from "../errors/domain-error";
import { err, ok, type Result } from "../result";

// A user-defined criterion. Maps to a Numbatch topic at the adapter boundary
// (ADR-0004): the semantic signal Numbatch classifies on is the topic's
// description + curated samples; redline references a requirement by `id` and
// carries a human `name` and prose `definition`.
export interface Requirement {
  readonly id: string;
  readonly name: string;
  readonly definition: string;
}

export interface MakeRequirementInput {
  readonly id: string;
  readonly name: string;
  readonly definition: string;
}

// Numbatch caps a profile at 10 topics (ADR-0004); more than 10 degrades some
// base models. A RequirementSet mirrors one profile, so it inherits that cap.
export const MAX_REQUIREMENTS_PER_SET = 10;

export const makeRequirement = (input: MakeRequirementInput): Result<Requirement> => {
  const id = input.id.trim();
  if (id === "") {
    return err(domainError("VALIDATION_FAILED", "requirement id must not be blank"));
  }

  const name = input.name.trim();
  if (name === "") {
    return err(domainError("VALIDATION_FAILED", "requirement name must not be blank"));
  }

  const definition = input.definition.trim();
  if (definition === "") {
    return err(domainError("VALIDATION_FAILED", "requirement definition must not be blank"));
  }

  return ok({ id, name, definition });
};

// An evaluation's ordered requirement set. Mirrors a Numbatch profile: ordered,
// unique by id, non-empty, and capped at MAX_REQUIREMENTS_PER_SET.
export interface RequirementSet {
  readonly evaluationId: string;
  readonly requirements: readonly Requirement[];
}

export interface MakeRequirementSetInput {
  readonly evaluationId: string;
  readonly requirements: readonly Requirement[];
}

export const makeRequirementSet = (
  input: MakeRequirementSetInput,
): Result<RequirementSet> => {
  if (input.requirements.length === 0) {
    return err(domainError("VALIDATION_FAILED", "a requirement set must have at least one requirement"));
  }

  if (input.requirements.length > MAX_REQUIREMENTS_PER_SET) {
    return err(
      domainError(
        "VALIDATION_FAILED",
        `a requirement set must have at most ${MAX_REQUIREMENTS_PER_SET} requirements`,
      ),
    );
  }

  const ids = new Set(input.requirements.map((requirement) => requirement.id));
  if (ids.size !== input.requirements.length) {
    return err(domainError("VALIDATION_FAILED", "requirement ids must be unique within a set"));
  }

  return ok({ evaluationId: input.evaluationId, requirements: [...input.requirements] });
};
