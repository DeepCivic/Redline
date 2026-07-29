import { domainError } from "../errors/domain-error";
import { err, ok, type Result } from "../result";

// A durable comprehension-lens criterion: a human name plus the prose
// definition retrieval matches chunk vectors against.
//
// A topic carries no evaluation binding (ADR-0009). It outlives any evaluation
// that uses it, which is what lets a lens compound; an evaluation-scoped
// criterion is a `Requirement`, projected from a topic in lens-projection.ts.
// The Numbatch `topic_id` binding is a separate record, not a field
// here — Numbatch's library is the system of record and redline holds
// references, not copies.
export interface Topic {
  readonly id: string;
  readonly name: string;
  readonly definition: string;
}

export interface MakeTopicInput {
  readonly id: string;
  readonly name: string;
  readonly definition: string;
}

export const makeTopic = (input: MakeTopicInput): Result<Topic> => {
  const id = input.id.trim();
  if (id === "") {
    return err(domainError("VALIDATION_FAILED", "topic id must not be blank"));
  }

  const name = input.name.trim();
  if (name === "") {
    return err(domainError("VALIDATION_FAILED", "topic name must not be blank"));
  }

  const definition = input.definition.trim();
  if (definition === "") {
    return err(domainError("VALIDATION_FAILED", "topic definition must not be blank"));
  }

  return ok({ id, name, definition });
};
