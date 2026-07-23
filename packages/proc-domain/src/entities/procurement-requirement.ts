import { domainError } from "../errors/domain-error";
import { err, ok, type Result } from "../result";

// Procurement responses are always scored against a fixed set of six
// requirements — this is a Numbatch-profile constant, not user configuration
// (see build plan §5). The per-requirement *categories* are the user-defined
// element; the requirement numbers themselves never change.
export const REQUIREMENT_NUMBERS = [1, 2, 3, 4, 5, 6] as const;

export type RequirementNumber = (typeof REQUIREMENT_NUMBERS)[number];

export const isRequirementNumber = (value: number): value is RequirementNumber =>
  (REQUIREMENT_NUMBERS as readonly number[]).includes(value);

// A requirement pairs a fixed number with a human title and the free-form
// categories a specialist wants responses bucketed into (e.g. requirement 6's
// "broad category"). Categories are the user-defined axis of the evaluation.
export interface ProcurementRequirement {
  readonly number: RequirementNumber;
  readonly title: string;
  readonly userDefinedCategories: readonly string[];
}

export interface MakeProcurementRequirementInput {
  readonly number: RequirementNumber;
  readonly title: string;
  readonly userDefinedCategories?: readonly string[];
}

const dedupeTrimmedNonEmpty = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

export const makeProcurementRequirement = (
  input: MakeProcurementRequirementInput,
): Result<ProcurementRequirement> => {
  if (!isRequirementNumber(input.number)) {
    return err(
      domainError(
        "VALIDATION_FAILED",
        `requirement number must be one of ${REQUIREMENT_NUMBERS.join(", ")}`,
      ),
    );
  }

  const title = input.title.trim();
  if (title === "") {
    return err(domainError("VALIDATION_FAILED", "requirement title must not be blank"));
  }

  return ok({
    number: input.number,
    title,
    userDefinedCategories: dedupeTrimmedNonEmpty(input.userDefinedCategories ?? []),
  });
};
