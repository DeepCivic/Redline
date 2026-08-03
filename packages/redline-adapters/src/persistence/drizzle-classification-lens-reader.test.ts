import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isErr, isOk, ok } from "@redline/redline-domain";
import { applyMigrations } from "./apply-migrations";
import { schema } from "./db";
import {
  redlineEvaluations,
  redlineHardRules,
  redlineLensBindings,
  redlineLenses,
  redlineTopics,
} from "./schema";
import { DrizzleClassificationLensReader } from "./drizzle-classification-lens-reader";

// The exit test for delivery-plan §2 item 1: a lens saved with its topics, its
// hard rules and its evaluation binding reads back byte-identical through
// IClassificationLensReader — definitions included, since those are what
// adjudication actually reads (ADR-0020).
//
// PGlite is a real Postgres in WASM, loaded from the same migration SQL that
// ships, so the FKs and the one-lens-per-evaluation index are genuinely exercised.

let pg: PGlite;
let database: ReturnType<typeof drizzle>;

const NO_CANDIDATES = async () => ok([]);

const seedLens = async () => {
  await database.insert(redlineEvaluations).values({
    id: "eval-1",
    name: "Tender 42",
    stage: "grouping",
  });
  await database.insert(redlineLenses).values({ id: "lens-1", name: "Fleet procurement" });
  await database.insert(redlineTopics).values([
    { id: "topic-safety", lensId: "lens-1", name: "Safety", definition: "Crash-worthiness.", position: 0 },
    { id: "topic-price", lensId: "lens-1", name: "Price", definition: "Whole-of-life cost.", position: 1 },
  ]);
  await database.insert(redlineHardRules).values([
    { id: "rule-1", lensId: "lens-1", pattern: "SEC-*", topicId: "topic-safety", declarationOrder: 0 },
    { id: "rule-2", lensId: "lens-1", pattern: "PRICE-*", topicId: "topic-price", declarationOrder: 1 },
  ]);
  await database
    .insert(redlineLensBindings)
    .values({ id: "binding-1", lensId: "lens-1", evaluationId: "eval-1" });
};

const readerWith = (deriveCandidates = NO_CANDIDATES) =>
  new DrizzleClassificationLensReader({ database, deriveCandidates });

beforeEach(async () => {
  pg = new PGlite();
  await applyMigrations((sql) => pg.exec(sql));
  database = drizzle(pg, { schema });
});

afterEach(async () => {
  await pg.close();
});

describe("DrizzleClassificationLensReader — the lens round-trip", () => {
  it("reads topics back byte-identical, definitions included, in stored order", async () => {
    await seedLens();

    const read = await readerWith().readLens({ evaluationId: "eval-1", documentIds: [] });

    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.topics).toEqual([
      { id: "topic-safety", name: "Safety", definition: "Crash-worthiness." },
      { id: "topic-price", name: "Price", definition: "Whole-of-life cost." },
    ]);
  });

  it("reads hard rules in declaration order, which is load-bearing (ADR-0011)", async () => {
    await seedLens();

    const read = await readerWith().readLens({ evaluationId: "eval-1", documentIds: [] });

    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.ruleSet.rules).toEqual([
      { id: "rule-1", pattern: "SEC-*", topicId: "topic-safety" },
      { id: "rule-2", pattern: "PRICE-*", topicId: "topic-price" },
    ]);
  });

  it("resolves the lens through the binding, not through a column on the lens", async () => {
    await seedLens();
    // A second evaluation with no binding sees no lens, though the lens exists.
    await database
      .insert(redlineEvaluations)
      .values({ id: "eval-2", name: "Tender 43", stage: "grouping" });

    const read = await readerWith().readLens({ evaluationId: "eval-2", documentIds: [] });

    expect(isErr(read)).toBe(true);
    if (!isErr(read)) return;
    expect(read.error.code).toBe("NOT_FOUND");
  });

  it("derives candidates per call rather than reading them from the store", async () => {
    await seedLens();
    const derive = async (_evaluationId: string, documentIds: readonly string[]) =>
      ok(documentIds.map((documentId) => ({ documentId, subjects: ["SEC-014"] })));

    const read = await readerWith(derive as typeof NO_CANDIDATES).readLens({
      evaluationId: "eval-1",
      documentIds: ["hashA", "hashB"],
    });

    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.candidates).toEqual([
      { documentId: "hashA", subjects: ["SEC-014"] },
      { documentId: "hashB", subjects: ["SEC-014"] },
    ]);
  });

  it("accepts a lens with no hard rules — every document then adjudicates (ADR-0008)", async () => {
    await seedLens();
    await database.delete(redlineHardRules);

    const read = await readerWith().readLens({ evaluationId: "eval-1", documentIds: [] });

    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.ruleSet.rules).toEqual([]);
    expect(read.data.topics).toHaveLength(2);
  });

  it("refuses a lens with no topics, which would leave adjudication nothing to choose", async () => {
    await seedLens();
    await database.delete(redlineHardRules);
    await database.delete(redlineTopics);

    const read = await readerWith().readLens({ evaluationId: "eval-1", documentIds: [] });

    expect(isErr(read)).toBe(true);
    if (!isErr(read)) return;
    expect(read.error.code).toBe("NOT_FOUND");
  });

  it("holds one lens per evaluation, so lens resolution is never ambiguous", async () => {
    await seedLens();
    await database.insert(redlineLenses).values({ id: "lens-2", name: "Rival lens" });

    const secondBinding = database
      .insert(redlineLensBindings)
      .values({ id: "binding-2", lensId: "lens-2", evaluationId: "eval-1" });

    await expect(secondBinding).rejects.toThrow();
  });
});
