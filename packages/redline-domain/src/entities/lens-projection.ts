import { domainError } from "../errors/domain-error";
import { err, type Result } from "../result";
import type { Lens } from "./lens";
import { makeRequirementSet, type Requirement, type RequirementSet } from "./requirement";
import type { Topic } from "./topic";

export interface ProjectRequirementSetInput {
  readonly lens: Lens;
  readonly evaluationId: string;
}

// A topic keeps its identity when bound to an evaluation, so a boundary
// decision recorded against a topic still bites on the requirement it becomes,
// and the adapter's requirementId <-> Numbatch topic_id binding stays a single
// mapping rather than two (ADR-0010).
const asRequirement = (topic: Topic): Requirement => ({
  id: topic.id,
  name: topic.name,
  definition: topic.definition,
});

// Binds a durable lens to one evaluation. The RequirementSet is the projection
// — disposable, rebuilt per evaluation — while the lens it came from outlives
// every evaluation that uses it (ADR-0009).
export const projectRequirementSet = (
  input: ProjectRequirementSetInput,
): Result<RequirementSet> => {
  const evaluationId = input.evaluationId.trim();
  if (evaluationId === "") {
    return err(domainError("VALIDATION_FAILED", "evaluation id must not be blank"));
  }

  return makeRequirementSet({
    evaluationId,
    requirements: input.lens.topics.map(asRequirement),
  });
};
