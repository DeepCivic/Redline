// DrizzleClassificationLensWriter — IClassificationLensWriter over the same four
// tables DrizzleClassificationLensReader reads (ADR-0009 for the shape, ADR-0011
// for why declaration order is stored rather than left to row order).
//
// The whole lens is written in one transaction because a half-written lens is a
// lens the reader rejects: topics without their binding resolve to NOT_FOUND,
// and rules without their topics violate the FK. Either the evaluation has a
// readable lens afterwards or it has exactly what it had before.
//
// Re-saving replaces. A seeding driver is re-run routinely and must not collide
// with redline_lens_bindings_evaluation_idx, so the binding for the evaluation
// and the lens's own topics and rules are cleared before the new set goes in.

import {
  domainError,
  err,
  isErr,
  makeHardRuleSet,
  makeTopic,
  ok,
  type ClassificationLensDefinition,
  type IClassificationLensWriter,
  type Result,
} from "@redline/redline-domain";
import { eq } from "drizzle-orm";
import {
  redlineHardRules,
  redlineLensBindings,
  redlineLenses,
  redlineTopics,
} from "./schema";

// The minimal drizzle surface used, kept structural so the postgres-js and
// PGlite instances both satisfy it without a driver import — the same treatment
// the reader and DrizzleChunkStore give their handles.
interface RedlineTransaction {
  insert: (table: unknown) => {
    values: (rows: unknown) => PromiseLike<unknown> & {
      onConflictDoUpdate: (config: unknown) => PromiseLike<unknown>;
    };
  };
  delete: (table: unknown) => {
    where: (predicate: unknown) => PromiseLike<unknown>;
  };
}

interface RedlineDb {
  transaction: <T>(callback: (tx: RedlineTransaction) => Promise<T>) => Promise<T>;
}

// The domain factories own the per-entity and set-level invariants (blank
// fields, duplicate rules, patterns that pin nothing). What they cannot see is
// whether a rule's topic belongs to the lens being saved, because a rule holds a
// plain topic reference — so that check lives here.
const validate = (definition: ClassificationLensDefinition): Result<void> => {
  if (definition.topics.length === 0) {
    return err(domainError("VALIDATION_FAILED", "a lens needs at least one topic"));
  }

  for (const topic of definition.topics) {
    const validated = makeTopic(topic);
    if (isErr(validated)) return validated;
  }

  const ruleSet = makeHardRuleSet({ rules: definition.rules });
  if (isErr(ruleSet)) return ruleSet;

  const topicIds = new Set(definition.topics.map((topic) => topic.id));
  const dangling = definition.rules.find((rule) => !topicIds.has(rule.topicId));
  if (dangling) {
    return err(
      domainError(
        "VALIDATION_FAILED",
        `hard rule ${dangling.id} points at unknown topic ${dangling.topicId}`,
      ),
    );
  }

  return ok(undefined);
};

const writeLens = async (
  tx: RedlineTransaction,
  definition: ClassificationLensDefinition,
): Promise<void> => {
  await tx.delete(redlineLensBindings).where(eq(redlineLensBindings.evaluationId, definition.evaluationId));
  await tx.delete(redlineHardRules).where(eq(redlineHardRules.lensId, definition.lensId));
  await tx.delete(redlineTopics).where(eq(redlineTopics.lensId, definition.lensId));

  await tx
    .insert(redlineLenses)
    .values({ id: definition.lensId, name: definition.name })
    .onConflictDoUpdate({
      target: redlineLenses.id,
      set: { name: definition.name, updatedAt: new Date() },
    });

  await tx.insert(redlineTopics).values(
    definition.topics.map((topic, position) => ({
      id: topic.id,
      lensId: definition.lensId,
      name: topic.name,
      definition: topic.definition,
      position,
    })),
  );

  if (definition.rules.length > 0) {
    await tx.insert(redlineHardRules).values(
      definition.rules.map((rule, declarationOrder) => ({
        id: rule.id,
        lensId: definition.lensId,
        pattern: rule.pattern,
        topicId: rule.topicId,
        declarationOrder,
      })),
    );
  }

  await tx.insert(redlineLensBindings).values({
    id: `${definition.lensId}:${definition.evaluationId}`,
    lensId: definition.lensId,
    evaluationId: definition.evaluationId,
  });
};

export class DrizzleClassificationLensWriter implements IClassificationLensWriter {
  private readonly db: RedlineDb;

  constructor(database: unknown) {
    this.db = database as RedlineDb;
  }

  async saveLens(definition: ClassificationLensDefinition): Promise<Result<void>> {
    const validated = validate(definition);
    if (isErr(validated)) return validated;

    try {
      await this.db.transaction((tx) => writeLens(tx, definition));
      return ok(undefined);
    } catch (cause) {
      return err(domainError("INFRA_FAILURE", "failed to save the classification lens", cause));
    }
  }
}
