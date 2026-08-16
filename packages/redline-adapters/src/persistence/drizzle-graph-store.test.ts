import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isOk } from "@redline/redline-domain";
import { applyMigrations } from "./apply-migrations";
import { schema } from "./db";
import {
  redlineGraphEdges,
  redlineGraphEntities,
  type NewGraphEdgeRow,
  type NewGraphEntityRow,
} from "./schema";
import { DrizzleGraphStore } from "./drizzle-graph-store";

// A real Postgres round-trip in-process (PGlite), from the same migration SQL that
// ships. The store is read-only over the enrich sidecars the sidecar's load path
// writes; here the test seeds the tables directly (standing in for that Python
// load) so the traversal surface is provable without the sidecar. The empty-graph
// case is asserted first-class: no enrich run means an empty table, and the store
// answers with an empty result rather than an error.

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
let store: DrizzleGraphStore;

const entity = (over: Partial<NewGraphEntityRow>): NewGraphEntityRow => ({
  evaluationId: "eval-1",
  documentId: "hashA",
  entityId: "hashA:per:0",
  entityLabel: "person",
  name: "Jane Doe",
  entityType: "natural",
  role: "seller",
  mentionStart: 10,
  mentionEnd: 18,
  chunkIndex: 3,
  ...over,
});

const edge = (over: Partial<NewGraphEdgeRow>): NewGraphEdgeRow => ({
  evaluationId: "eval-1",
  documentId: "hashA",
  sourceId: "hashA:per:0",
  targetId: "hashA:chunk:3",
  relation: "mentioned_in",
  propKey: "start",
  propValue: "10",
  ...over,
});

const seedEntity = async (row: NewGraphEntityRow) => {
  await database.insert(redlineGraphEntities).values(row);
};
const seedEdge = async (row: NewGraphEdgeRow) => {
  await database.insert(redlineGraphEdges).values(row);
};

beforeEach(async () => {
  pg = new PGlite();
  await applyMigrations((sql) => pg.exec(sql));
  database = drizzle(pg, { schema });
  store = new DrizzleGraphStore(database);
});

afterEach(async () => {
  await pg.close();
});

describe("DrizzleGraphStore — round-trip", () => {
  it("reads an entity mention back field by field", async () => {
    await seedEntity(entity({ entityId: "hashA:per:0", mentionStart: 10 }));

    const result = await store.fetchEntities("eval-1", { documentId: "hashA" });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toEqual([
      {
        documentId: "hashA",
        entityId: "hashA:per:0",
        entityLabel: "person",
        name: "Jane Doe",
        entityType: "natural",
        role: "seller",
        mentionStart: 10,
        mentionEnd: 18,
        chunkIndex: 3,
      },
    ]);
  });

  it("filters entities by label and by the chunk they fall in", async () => {
    await seedEntity(entity({ entityId: "p0", entityLabel: "person", chunkIndex: 3 }));
    await seedEntity(entity({ entityId: "l0", entityLabel: "location", chunkIndex: 3 }));
    await seedEntity(entity({ entityId: "p1", entityLabel: "person", chunkIndex: 7 }));

    const byLabel = await store.fetchEntities("eval-1", { entityLabel: "person" });
    const byChunk = await store.fetchEntities("eval-1", { chunkIndex: 3 });

    expect(isOk(byLabel)).toBe(true);
    expect(isOk(byChunk)).toBe(true);
    if (!isOk(byLabel) || !isOk(byChunk)) return;
    expect(byLabel.data.map((row) => row.entityId)).toEqual(["p0", "p1"]);
    expect(byChunk.data.map((row) => row.entityId).sort()).toEqual(["l0", "p0"]);
  });

  it("orders entities deterministically", async () => {
    await seedEntity(entity({ entityId: "b", mentionStart: 50 }));
    await seedEntity(entity({ entityId: "a", mentionStart: 30 }));
    await seedEntity(entity({ entityId: "a", mentionStart: 10 }));

    const first = await store.fetchEntities("eval-1", {});
    const second = await store.fetchEntities("eval-1", {});

    expect(isOk(first)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    expect(first.data.map((row) => [row.entityId, row.mentionStart])).toEqual([
      ["a", 10],
      ["a", 30],
      ["b", 50],
    ]);
    expect(second.data).toEqual(first.data);
  });

  it("follows edges out of an entity in a stable order", async () => {
    await seedEdge(edge({ sourceId: "e0", targetId: "hashA:chunk:3", relation: "mentioned_in" }));
    await seedEdge(edge({ sourceId: "e0", targetId: "hashA:loc:1", relation: "co_occurs", propKey: "" }));
    await seedEdge(edge({ sourceId: "e9", targetId: "hashA:chunk:5", propKey: "" }));

    const result = await store.fetchEdgesFrom("eval-1", "e0");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.targetId)).toEqual(["hashA:chunk:3", "hashA:loc:1"]);
  });

  it("follows edges into an entity", async () => {
    await seedEdge(edge({ sourceId: "e0", targetId: "t1", propKey: "" }));
    await seedEdge(edge({ sourceId: "e2", targetId: "t1", propKey: "" }));
    await seedEdge(edge({ sourceId: "e0", targetId: "other", propKey: "" }));

    const result = await store.fetchEdgesTo("eval-1", "t1");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.map((row) => row.sourceId)).toEqual(["e0", "e2"]);
  });

  it("returns an empty result when no graph is loaded — the runtime-absent case", async () => {
    const entities = await store.fetchEntities("eval-1", {});
    const edgesFrom = await store.fetchEdgesFrom("eval-1", "anything");
    const edgesTo = await store.fetchEdgesTo("eval-1", "anything");

    expect(isOk(entities)).toBe(true);
    expect(isOk(edgesFrom)).toBe(true);
    expect(isOk(edgesTo)).toBe(true);
    if (!isOk(entities) || !isOk(edgesFrom) || !isOk(edgesTo)) return;
    expect(entities.data).toEqual([]);
    expect(edgesFrom.data).toEqual([]);
    expect(edgesTo.data).toEqual([]);
  });

  it("probes availability without reading the whole entity table", async () => {
    await seedEntity(entity({ entityId: "one" }));
    await seedEntity(entity({ entityId: "two" }));

    const captured: string[] = [];
    pg.query = new Proxy(pg.query, {
      apply: (target, thisArg, args: unknown[]) => {
        captured.push(String(args[0]));
        return Reflect.apply(target, thisArg, args);
      },
    });

    const result = await store.hasEntities("eval-1");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toBe(true);
    // The point of the probe: one bounded row, never the ~90k-row read the tool
    // row cap exists to prevent.
    expect(captured.some((sql) => /limit \$?\d+/i.test(sql))).toBe(true);
    expect(captured.some((sql) => /order by/i.test(sql))).toBe(false);
  });

  it("probes availability as false when no enrich run has loaded a graph", async () => {
    const result = await store.hasEntities("eval-1");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toBe(false);
  });

  it("scopes the availability probe to one evaluation", async () => {
    await seedEntity(entity({ evaluationId: "eval-1", entityId: "one" }));

    const result = await store.hasEntities("eval-2");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data).toBe(false);
  });

  it("scopes entities and edges by evaluation", async () => {
    await seedEntity(entity({ evaluationId: "eval-1", entityId: "one" }));
    await seedEntity(entity({ evaluationId: "eval-2", entityId: "two" }));
    await seedEdge(edge({ evaluationId: "eval-1", sourceId: "s", targetId: "one", propKey: "" }));
    await seedEdge(edge({ evaluationId: "eval-2", sourceId: "s", targetId: "two", propKey: "" }));

    const entities = await store.fetchEntities("eval-2", {});
    const edges = await store.fetchEdgesFrom("eval-2", "s");

    expect(isOk(entities)).toBe(true);
    expect(isOk(edges)).toBe(true);
    if (!isOk(entities) || !isOk(edges)) return;
    expect(entities.data.map((row) => row.entityId)).toEqual(["two"]);
    expect(edges.data.map((row) => row.targetId)).toEqual(["two"]);
  });
});

describe("redline_graph migration idempotency", () => {
  it("applies the migrations a second time without error", async () => {
    await expect(applyMigrations((sql) => pg.exec(sql))).resolves.toBeUndefined();
    await seedEntity(entity({ entityId: "after" }));
    const result = await store.fetchEntities("eval-1", {});
    expect(isOk(result)).toBe(true);
  });
});
