import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { isOk } from "@redline/redline-domain";
import { applyMigrations } from "./apply-migrations";
import { schema } from "./db";
import { DrizzleEvaluationRepository } from "./drizzle-evaluation-repository";

// A real Postgres round-trip in-process (PGlite = Postgres compiled to WASM), so
// the exit test runs with zero external services. The same migration SQL that
// ships to production builds the schema here.

let pg: PGlite;
let repository: DrizzleEvaluationRepository;

beforeEach(async () => {
  pg = new PGlite();
  await applyMigrations((sql) => pg.exec(sql));
  const database = drizzle(pg, { schema });
  repository = new DrizzleEvaluationRepository(database);
});

afterEach(async () => {
  await pg.close();
});

const evaluation = { id: "eval-1", name: "Cloud RFT", stage: "grouping" as const };

describe("DrizzleEvaluationRepository — round-trip", () => {
  it("saves and reads back an evaluation", async () => {
    const saved = await repository.saveEvaluation(evaluation);
    expect(isOk(saved)).toBe(true);

    const found = await repository.findEvaluation("eval-1");
    expect(isOk(found)).toBe(true);
    if (!isOk(found)) return;
    expect(found.data).toEqual(evaluation);
  });

  it("upserts an evaluation on re-save (advancing the stage)", async () => {
    await repository.saveEvaluation(evaluation);
    await repository.saveEvaluation({ ...evaluation, stage: "classifying" });

    const found = await repository.findEvaluation("eval-1");
    expect(isOk(found)).toBe(true);
    if (!isOk(found)) return;
    expect(found.data.stage).toBe("classifying");
  });

  it("returns NOT_FOUND for a missing evaluation", async () => {
    const found = await repository.findEvaluation("nope");
    expect(isOk(found)).toBe(false);
    if (isOk(found)) return;
    expect(found.error.code).toBe("NOT_FOUND");
  });

  it("saves and lists vendors, preserving consortium members", async () => {
    await repository.saveEvaluation(evaluation);
    await repository.saveVendor("eval-1", {
      id: "v-acme",
      displayName: "Acme",
      isConsortium: false,
      memberVendorIds: [],
    });
    await repository.saveVendor("eval-1", {
      id: "v-jv",
      displayName: "Acme + Beta",
      isConsortium: true,
      memberVendorIds: ["v-acme", "v-beta"],
    });

    const vendors = await repository.listVendors("eval-1");
    expect(isOk(vendors)).toBe(true);
    if (!isOk(vendors)) return;
    expect(vendors.data).toHaveLength(2);
    const jointVenture = vendors.data.find((vendor) => vendor.id === "v-jv")!;
    expect(jointVenture.memberVendorIds).toEqual(["v-acme", "v-beta"]);
  });

  it("saves and lists response groups with their id arrays", async () => {
    await repository.saveEvaluation(evaluation);
    await repository.saveResponseGroup({
      id: "g1",
      evaluationId: "eval-1",
      vendorIds: ["v-acme"],
      label: "Acme — Core Bid",
      documentIds: ["82f9355e", "5c1a7be0"],
      isConsortiumResponse: false,
    });

    const groups = await repository.listResponseGroups("eval-1");
    expect(isOk(groups)).toBe(true);
    if (!isOk(groups)) return;
    expect(groups.data).toHaveLength(1);
    expect(groups.data[0]!.documentIds).toEqual(["82f9355e", "5c1a7be0"]);
  });

  it("saves responses and reads currency back as a real number", async () => {
    await repository.saveEvaluation(evaluation);
    const saved = await repository.saveResponses([
      {
        evaluationId: "eval-1",
        responseGroupId: "g1",
        vendorName: "Acme",
        productName: "Acme Cloud",
        requirementId: "req-data-residency",
        confidence: 0.86,
        productSummary: "Sovereign hosting.",
        costing: { estimateAud: 1500.5, description: "Annual" },
        source: { documentId: "82f9355e", elementOrder: 7, page: 3, chunkId: "82f9355e:4" },
      },
      {
        evaluationId: "eval-1",
        responseGroupId: "g1",
        vendorName: "Beta",
        productName: "Beta Stack",
        requirementId: "req-support-sla",
        confidence: 0.61,
        productSummary: "Priced on application.",
        costing: { estimateAud: null, description: "POA; see section 4." },
        source: { documentId: "5c1a7be0", elementOrder: 0, page: null, chunkId: null },
      },
    ]);
    expect(isOk(saved)).toBe(true);

    const responses = await repository.listResponses("eval-1");
    expect(isOk(responses)).toBe(true);
    if (!isOk(responses)) return;
    expect(responses.data).toHaveLength(2);
    const residency = responses.data.find(
      (response) => response.requirementId === "req-data-residency",
    )!;
    expect(residency.costing.estimateAud).toBe(1500.5);
    const support = responses.data.find(
      (response) => response.requirementId === "req-support-sla",
    )!;
    expect(support.costing.estimateAud).toBeNull();
    expect(support.costing.description).toBe("POA; see section 4.");
  });

  it("cascades response-group and vendor scope by evaluation", async () => {
    await repository.saveEvaluation(evaluation);
    await repository.saveEvaluation({ id: "eval-2", name: "Other", stage: "grouping" });
    await repository.saveVendor("eval-1", {
      id: "v1",
      displayName: "Acme",
      isConsortium: false,
      memberVendorIds: [],
    });

    const otherVendors = await repository.listVendors("eval-2");
    expect(isOk(otherVendors)).toBe(true);
    if (!isOk(otherVendors)) return;
    expect(otherVendors.data).toHaveLength(0);
  });
});

describe("redline_ migration idempotency", () => {
  it("applies the migration a second time without error", async () => {
    // beforeEach already applied it once; a second run must be a no-op.
    await expect(applyMigrations((sql) => pg.exec(sql))).resolves.toBeUndefined();
    // And the schema still works after the re-run.
    const saved = await repository.saveEvaluation(evaluation);
    expect(isOk(saved)).toBe(true);
  });
});
