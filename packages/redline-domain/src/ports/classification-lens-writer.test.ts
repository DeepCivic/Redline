import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err, type Result } from "../result";
import { domainError } from "../errors/domain-error";
import type { HardRule } from "../entities/hard-rule";
import type { Topic } from "../entities/topic";
import type { ClassificationLensDefinition, IClassificationLensWriter } from "./classification-lens-writer";
import type { ClassificationLensRequest, ClassificationLens } from "./classification-lens-reader";
import { makeHardRuleSet } from "../entities/hard-rule";

// The write half of the lens seam. This test is the port's spec, and it pins the
// two properties a re-runnable seeding driver depends on: array order IS the
// stored order (the caller never numbers anything), and saving the same lens
// twice replaces rather than collides.

// An in-memory pair: one store satisfying both the writer and the reader, so
// the round-trip is proven at the port level rather than assumed of the adapter.
class InMemoryLensStore implements IClassificationLensWriter {
  private readonly topicsByLens = new Map<string, readonly Topic[]>();
  private readonly rulesByLens = new Map<string, readonly HardRule[]>();
  private readonly lensByEvaluation = new Map<string, string>();

  async saveLens(definition: ClassificationLensDefinition): Promise<Result<void>> {
    if (definition.topics.length === 0) {
      return err(domainError("VALIDATION_FAILED", "a lens needs at least one topic"));
    }

    const topicIds = new Set(definition.topics.map((topic) => topic.id));
    const danglingRule = definition.rules.find((rule) => !topicIds.has(rule.topicId));
    if (danglingRule) {
      return err(
        domainError(
          "VALIDATION_FAILED",
          `hard rule ${danglingRule.id} points at unknown topic ${danglingRule.topicId}`,
        ),
      );
    }

    this.topicsByLens.set(definition.lensId, definition.topics);
    this.rulesByLens.set(definition.lensId, definition.rules);
    this.lensByEvaluation.set(definition.evaluationId, definition.lensId);
    return ok(undefined);
  }

  async readLens(request: ClassificationLensRequest): Promise<Result<ClassificationLens>> {
    const lensId = this.lensByEvaluation.get(request.evaluationId);
    if (lensId === undefined) {
      return err(domainError("NOT_FOUND", `no lens is bound to evaluation ${request.evaluationId}`));
    }

    const ruleSet = makeHardRuleSet({ rules: this.rulesByLens.get(lensId) ?? [] });
    if (isErr(ruleSet)) return ruleSet;

    return ok({ topics: this.topicsByLens.get(lensId) ?? [], ruleSet: ruleSet.data, candidates: [] });
  }
}

const SAFETY: Topic = { id: "topic-safety", name: "Safety", definition: "Crash-worthiness." };
const PRICE: Topic = { id: "topic-price", name: "Price", definition: "Whole-of-life cost." };

const definition = (overrides: Partial<ClassificationLensDefinition> = {}): ClassificationLensDefinition => ({
  lensId: "lens-1",
  name: "Fleet procurement",
  evaluationId: "eval-1",
  topics: [SAFETY, PRICE],
  rules: [
    { id: "rule-1", pattern: "SEC-*", topicId: "topic-safety" },
    { id: "rule-2", pattern: "PRICE-*", topicId: "topic-price" },
  ],
  ...overrides,
});

describe("IClassificationLensWriter — the write half of the lens seam", () => {
  it("saves a lens the reader can then resolve for the bound evaluation", async () => {
    const store = new InMemoryLensStore();

    const saved = await store.saveLens(definition());

    expect(isOk(saved)).toBe(true);
    const read = await store.readLens({ evaluationId: "eval-1", documentIds: [] });
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.topics).toEqual([SAFETY, PRICE]);
  });

  it("takes array order as the stored order, so the caller numbers nothing", async () => {
    const store = new InMemoryLensStore();

    await store.saveLens(definition({ topics: [PRICE, SAFETY] }));

    const read = await store.readLens({ evaluationId: "eval-1", documentIds: [] });
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.topics.map((topic) => topic.id)).toEqual(["topic-price", "topic-safety"]);
  });

  it("replaces on re-save, so a seeding driver can be run twice", async () => {
    const store = new InMemoryLensStore();
    await store.saveLens(definition());

    const resaved = await store.saveLens(
      definition({ topics: [SAFETY], rules: [{ id: "rule-1", pattern: "SEC-*", topicId: "topic-safety" }] }),
    );

    expect(isOk(resaved)).toBe(true);
    const read = await store.readLens({ evaluationId: "eval-1", documentIds: [] });
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.topics).toEqual([SAFETY]);
    expect(read.data.ruleSet.rules).toHaveLength(1);
  });

  it("refuses a lens with no topics, which would leave adjudication nothing to choose", async () => {
    const store = new InMemoryLensStore();

    const saved = await store.saveLens(definition({ topics: [], rules: [] }));

    expect(isErr(saved)).toBe(true);
    if (!isErr(saved)) return;
    expect(saved.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a hard rule pointing at a topic the lens does not define", async () => {
    const store = new InMemoryLensStore();

    const saved = await store.saveLens(
      definition({ rules: [{ id: "rule-9", pattern: "ENV-*", topicId: "topic-environment" }] }),
    );

    expect(isErr(saved)).toBe(true);
    if (!isErr(saved)) return;
    expect(saved.error.code).toBe("VALIDATION_FAILED");
  });

  it("accepts a lens with no hard rules — every document then adjudicates (ADR-0008)", async () => {
    const store = new InMemoryLensStore();

    const saved = await store.saveLens(definition({ rules: [] }));

    expect(isOk(saved)).toBe(true);
    const read = await store.readLens({ evaluationId: "eval-1", documentIds: [] });
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.ruleSet.rules).toEqual([]);
  });
});
