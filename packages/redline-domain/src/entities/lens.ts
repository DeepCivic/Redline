import { domainError } from "../errors/domain-error";
import { err, ok, type Result } from "../result";
import type { Topic } from "./topic";

// Below two topics there is nothing to sort between, so the collision loop the
// lens exists to drive has no work to do (design doc §2: "2-10 topics").
export const MIN_TOPICS_PER_LENS = 2;

// The same Numbatch per-profile ceiling that caps a RequirementSet
// (MAX_REQUIREMENTS_PER_SET, ADR-0004): more than 10 topics degrades some base
// models. Restated here rather than imported so the durable tier does not
// depend on its own evaluation-scoped projection; lens-projection.test.ts holds
// the two constants to the same value.
export const MAX_TOPICS_PER_LENS = 10;

// The durable asset: a named set of topics, plus (from Thread 18) the hard
// rules and boundary decisions that sharpen them.
//
// A lens carries no `evaluationId` (ADR-0009). It is defined once and applied
// to any corpus; binding it to an evaluation produces a `RequirementSet`, which
// is a projection rather than the lens itself.
export interface Lens {
  readonly id: string;
  readonly name: string;
  readonly topics: readonly Topic[];
}

export interface MakeLensInput {
  readonly id: string;
  readonly name: string;
  readonly topics: readonly Topic[];
}

export const makeLens = (input: MakeLensInput): Result<Lens> => {
  const id = input.id.trim();
  if (id === "") {
    return err(domainError("VALIDATION_FAILED", "lens id must not be blank"));
  }

  const name = input.name.trim();
  if (name === "") {
    return err(domainError("VALIDATION_FAILED", "lens name must not be blank"));
  }

  if (input.topics.length < MIN_TOPICS_PER_LENS) {
    return err(
      domainError(
        "VALIDATION_FAILED",
        `a lens must have at least ${MIN_TOPICS_PER_LENS} topics`,
      ),
    );
  }

  if (input.topics.length > MAX_TOPICS_PER_LENS) {
    return err(
      domainError(
        "VALIDATION_FAILED",
        `a lens must have at most ${MAX_TOPICS_PER_LENS} topics`,
      ),
    );
  }

  const ids = new Set(input.topics.map((topic) => topic.id));
  if (ids.size !== input.topics.length) {
    return err(domainError("VALIDATION_FAILED", "topic ids must be unique within a lens"));
  }

  return ok({ id, name, topics: [...input.topics] });
};
