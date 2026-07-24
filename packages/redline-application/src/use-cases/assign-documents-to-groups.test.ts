import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import { InMemoryEvaluationRepository } from "./in-memory-evaluation-repository.test-support";
import { AssignDocumentsToGroups } from "./assign-documents-to-groups";

// The evaluation must be at `grouping` before docs can be assigned, so each test
// seeds one there first.
const seededRepository = async () => {
  const repository = new InMemoryEvaluationRepository();
  await repository.saveEvaluation({ id: "eval-1", name: "Cloud RFP", stage: "grouping" });
  return repository;
};

const input = () => ({
  evaluationId: "eval-1",
  vendors: [
    { id: "v-acme", displayName: "Acme" },
    { id: "v-globex", displayName: "Globex" },
  ],
  groups: [
    {
      id: "g-acme",
      vendorIds: ["v-acme"],
      label: "Acme — Core Platform",
      documentIds: ["doc-a", "doc-b"],
    },
    {
      id: "g-globex",
      vendorIds: ["v-globex"],
      label: "Globex — Managed Service",
      documentIds: ["doc-c"],
    },
  ],
});

describe("AssignDocumentsToGroups", () => {
  it("persists vendors and groups then advances the stage to classifying", async () => {
    const repository = await seededRepository();
    const useCase = new AssignDocumentsToGroups({ repository });

    const result = await useCase.execute(input());

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.stage).toBe("classifying");
    expect(repository.vendors.get("eval-1")).toHaveLength(2);
    const groups = repository.groups.get("eval-1") ?? [];
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.id === "g-acme")?.documentIds).toEqual(["doc-a", "doc-b"]);
  });

  it("marks a multi-vendor group as a consortium response", async () => {
    const repository = await seededRepository();
    const useCase = new AssignDocumentsToGroups({ repository });

    const result = await useCase.execute({
      evaluationId: "eval-1",
      vendors: [
        { id: "v-acme", displayName: "Acme" },
        { id: "v-globex", displayName: "Globex" },
      ],
      groups: [
        {
          id: "g-consortium",
          vendorIds: ["v-acme", "v-globex"],
          label: "Acme + Globex — Joint Bid",
          documentIds: ["doc-a"],
        },
      ],
    });

    expect(isOk(result)).toBe(true);
    const group = (repository.groups.get("eval-1") ?? [])[0];
    expect(group?.isConsortiumResponse).toBe(true);
  });

  it("rejects a group whose vendor is not in the vendor list", async () => {
    const repository = await seededRepository();
    const useCase = new AssignDocumentsToGroups({ repository });

    const result = await useCase.execute({
      evaluationId: "eval-1",
      vendors: [{ id: "v-acme", displayName: "Acme" }],
      groups: [
        { id: "g-x", vendorIds: ["v-ghost"], label: "Ghost", documentIds: ["doc-a"] },
      ],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("fails when the evaluation is not yet at the grouping stage", async () => {
    const repository = new InMemoryEvaluationRepository();
    await repository.saveEvaluation({ id: "eval-1", name: "Cloud RFP", stage: "documents_uploaded" });
    const useCase = new AssignDocumentsToGroups({ repository });

    const result = await useCase.execute(input());

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
