import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isErr, isOk, ok } from "@redline/redline-domain";
import { applyMigrations } from "./apply-migrations";
import { schema } from "./db";
import { redlineEvaluations } from "./schema";
import { DrizzleClassificationLensWriter } from "./drizzle-classification-lens-writer";
import { DrizzleClassificationLensReader } from "./drizzle-classification-lens-reader";

// The writer's spec, proven through the reader it exists to feed: what goes in
// comes back out in the same order, and a second save of the same lens replaces
// rather than colliding with redline_lens_bindings_evaluation_idx.
//
// PGlite is a real Postgres in WASM loaded from the shipped migration SQL, so
// the FKs and the one-lens-per-evaluation index genuinely bite here.

let pg: PGlite;
let database: ReturnType<typeof drizzle>;

const NO_CANDIDATES = async () => ok([]);

const SAFETY = { id: "topic-safety", name: "Safety", definition: "Crash-worthiness." };
const PRICE = { id: "topic-price", name: "Price", definition: "Whole-of-life cost." };

const lensDefinition = () => ({
  lensId: "lens-1",
  name: "Fleet procurement",
  evaluationId: "eval-1",
  topics: [SAFETY, PRICE],
  rules: [
    { id: "rule-1", pattern: "SEC-*", topicId: "topic-safety" },
    { id: "rule-2", pattern: "PRICE-*", topicId: "topic-price" },
  ],
});

const readBack = () =>
  new DrizzleClassificationLensReader({ database, deriveCandidates: NO_CANDIDATES }).readLens({
    evaluationId: "eval-1",
    documentIds: [],
  });

beforeEach(async () => {
  pg = new PGlite();
  await applyMigrations((sql) => pg.exec(sql));
  database = drizzle(pg, { schema });
  await database
    .insert(redlineEvaluations)
    .values({ id: "eval-1", name: "Tender 42", stage: "grouping" });
});

afterEach(async () => {
  await pg.close();
});

describe("DrizzleClassificationLensWriter — seeding the lens the classifier reads", () => {
  it("writes a lens the reader resolves for the bound evaluation", async () => {
    const saved = await new DrizzleClassificationLensWriter(database).saveLens(lensDefinition());

    expect(isOk(saved)).toBe(true);
    const read = await readBack();
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.topics).toEqual([SAFETY, PRICE]);
    expect(read.data.ruleSet.rules).toEqual([
      { id: "rule-1", pattern: "SEC-*", topicId: "topic-safety" },
      { id: "rule-2", pattern: "PRICE-*", topicId: "topic-price" },
    ]);
  });

  it("stores array order as position and declaration order", async () => {
    await new DrizzleClassificationLensWriter(database).saveLens({
      ...lensDefinition(),
      topics: [PRICE, SAFETY],
      rules: [
        { id: "rule-2", pattern: "PRICE-*", topicId: "topic-price" },
        { id: "rule-1", pattern: "SEC-*", topicId: "topic-safety" },
      ],
    });

    const read = await readBack();
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.topics.map((topic) => topic.id)).toEqual(["topic-price", "topic-safety"]);
    expect(read.data.ruleSet.rules.map((rule) => rule.id)).toEqual(["rule-2", "rule-1"]);
  });

  it("replaces on re-save, so the seeding driver can be re-run", async () => {
    const writer = new DrizzleClassificationLensWriter(database);
    await writer.saveLens(lensDefinition());

    const resaved = await writer.saveLens({
      ...lensDefinition(),
      name: "Fleet procurement (revised)",
      topics: [SAFETY],
      rules: [{ id: "rule-1", pattern: "SEC-*", topicId: "topic-safety" }],
    });

    expect(isOk(resaved)).toBe(true);
    const read = await readBack();
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.topics).toEqual([SAFETY]);
    expect(read.data.ruleSet.rules).toHaveLength(1);
  });

  it("rebinds when a different lens is saved against the same evaluation", async () => {
    const writer = new DrizzleClassificationLensWriter(database);
    await writer.saveLens(lensDefinition());
    const environment = {
      id: "topic-environment",
      name: "Environment",
      definition: "Emissions over the fleet's life.",
    };

    const rebound = await writer.saveLens({
      ...lensDefinition(),
      lensId: "lens-2",
      name: "Rival lens",
      topics: [environment],
      rules: [],
    });

    expect(isOk(rebound)).toBe(true);
    const read = await readBack();
    expect(isOk(read)).toBe(true);
    if (!isOk(read)) return;
    expect(read.data.topics).toEqual([environment]);
  });

  // redline_topics.id is a global primary key, so a topic belongs to exactly one
  // lens. A second lens reusing an id is a mistake worth surfacing, not a silent
  // reassignment of the first lens's topic.
  it("refuses a second lens that reuses another lens's topic id", async () => {
    const writer = new DrizzleClassificationLensWriter(database);
    await writer.saveLens(lensDefinition());

    const collided = await writer.saveLens({
      ...lensDefinition(),
      lensId: "lens-2",
      name: "Rival lens",
      topics: [PRICE],
      rules: [],
    });

    expect(isErr(collided)).toBe(true);
    if (!isErr(collided)) return;
    expect(collided.error.code).toBe("INFRA_FAILURE");
  });

  it("refuses a lens with no topics rather than writing one the reader rejects", async () => {
    const saved = await new DrizzleClassificationLensWriter(database).saveLens({
      ...lensDefinition(),
      topics: [],
      rules: [],
    });

    expect(isErr(saved)).toBe(true);
    if (!isErr(saved)) return;
    expect(saved.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses a hard rule pointing at a topic the lens does not define", async () => {
    const saved = await new DrizzleClassificationLensWriter(database).saveLens({
      ...lensDefinition(),
      rules: [{ id: "rule-9", pattern: "ENV-*", topicId: "topic-environment" }],
    });

    expect(isErr(saved)).toBe(true);
    if (!isErr(saved)) return;
    expect(saved.error.code).toBe("VALIDATION_FAILED");
  });

  it("reports an unknown evaluation as a domain error, not a driver exception", async () => {
    const saved = await new DrizzleClassificationLensWriter(database).saveLens({
      ...lensDefinition(),
      evaluationId: "eval-missing",
    });

    expect(isErr(saved)).toBe(true);
    if (!isErr(saved)) return;
    expect(saved.error.code).toBe("INFRA_FAILURE");
  });

  it("leaves no partial lens behind when the write fails", async () => {
    const writer = new DrizzleClassificationLensWriter(database);

    await writer.saveLens({ ...lensDefinition(), evaluationId: "eval-missing" });

    // The binding is what failed; the lens and its topics must not survive it.
    const read = await readBack();
    expect(isErr(read)).toBe(true);
    if (!isErr(read)) return;
    expect(read.error.code).toBe("NOT_FOUND");
  });
});
