import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@redline/redline-domain";
import { WorkflowManager } from "./workflow-manager";

// The workflow-manager core is the specialist control surface's brain: a pure,
// in-memory model of the drag-docs-into-groups composition. It holds no ports —
// the container drives it and hands its output to AssignDocumentsToGroups. These
// tests are the exit test's substance: the three relationship shapes compose,
// and stage advance is gated on a valid composition.

const documentIds = ["doc-1", "doc-2", "doc-3", "doc-4"] as const;

const managerWithDocuments = () =>
  new WorkflowManager({ evaluationId: "eval-1", stage: "grouping", documentIds });

describe("WorkflowManager — composition of relationship shapes", () => {
  it("shape 1: one vendor → many docs → one response", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-acme", label: "Acme — Core Bid", vendorIds: ["v-acme"] });
    manager.assignDocument("g-acme", "doc-1");
    manager.assignDocument("g-acme", "doc-2");

    const snapshot = manager.snapshot();
    const group = snapshot.groups.find((candidate) => candidate.id === "g-acme");
    expect(group?.documentIds).toEqual(["doc-1", "doc-2"]);
    expect(group?.vendorIds).toEqual(["v-acme"]);
    expect(group?.isConsortiumResponse).toBe(false);
  });

  it("shape 2: many vendors → one consortium response", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-a", displayName: "Alpha" });
    manager.addVendor({ id: "v-b", displayName: "Beta" });
    manager.createGroup({ id: "g-jv", label: "Alpha+Beta JV", vendorIds: ["v-a", "v-b"] });
    manager.assignDocument("g-jv", "doc-1");

    const consortium = manager.markConsortium({
      id: "c-jv",
      displayName: "Alpha+Beta Consortium",
      memberVendorIds: ["v-a", "v-b"],
    });
    expect(isOk(consortium)).toBe(true);

    const snapshot = manager.snapshot();
    const group = snapshot.groups.find((candidate) => candidate.id === "g-jv");
    expect(group?.vendorIds).toEqual(["v-a", "v-b"]);
    expect(group?.isConsortiumResponse).toBe(true);
    const consortiumVendor = snapshot.vendors.find((vendor) => vendor.id === "c-jv");
    expect(consortiumVendor?.isConsortium).toBe(true);
    expect(consortiumVendor?.memberVendorIds).toEqual(["v-a", "v-b"]);
  });

  it("shape 3: one vendor → many responses (split multiple bids)", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-core", label: "Acme — Core", vendorIds: ["v-acme"] });
    manager.createGroup({ id: "g-premium", label: "Acme — Premium", vendorIds: ["v-acme"] });
    manager.assignDocument("g-core", "doc-1");
    manager.assignDocument("g-premium", "doc-2");

    const snapshot = manager.snapshot();
    const forAcme = snapshot.groups.filter((group) => group.vendorIds.includes("v-acme"));
    expect(forAcme).toHaveLength(2);
    expect(forAcme.map((group) => group.id)).toEqual(["g-core", "g-premium"]);
  });
});

describe("WorkflowManager — moving and unassigning documents", () => {
  it("moves a document to the group it is dropped on (a doc lives in one group)", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-1", label: "Bid 1", vendorIds: ["v-acme"] });
    manager.createGroup({ id: "g-2", label: "Bid 2", vendorIds: ["v-acme"] });
    manager.assignDocument("g-1", "doc-1");
    manager.assignDocument("g-2", "doc-1");

    const snapshot = manager.snapshot();
    expect(snapshot.groups.find((group) => group.id === "g-1")?.documentIds).toEqual([]);
    expect(snapshot.groups.find((group) => group.id === "g-2")?.documentIds).toEqual(["doc-1"]);
    expect(snapshot.unassignedDocumentIds).toEqual(["doc-2", "doc-3", "doc-4"]);
  });

  it("returns an unassigned document to the tray", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-1", label: "Bid 1", vendorIds: ["v-acme"] });
    manager.assignDocument("g-1", "doc-1");
    manager.unassignDocument("doc-1");

    const snapshot = manager.snapshot();
    expect(snapshot.groups.find((group) => group.id === "g-1")?.documentIds).toEqual([]);
    expect(snapshot.unassignedDocumentIds).toContain("doc-1");
  });
});

describe("WorkflowManager — validation of the composition", () => {
  it("rejects assigning an unknown document", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-1", label: "Bid 1", vendorIds: ["v-acme"] });

    const result = manager.assignDocument("g-1", "doc-unknown");
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a group referencing a vendor that was never added", () => {
    const manager = managerWithDocuments();
    const result = manager.createGroup({ id: "g-1", label: "Bid 1", vendorIds: ["ghost"] });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("marking a consortium needs at least two members", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-a", displayName: "Alpha" });
    const result = manager.markConsortium({
      id: "c-solo",
      displayName: "Solo",
      memberVendorIds: ["v-a"],
    });
    expect(isErr(result)).toBe(true);
  });
});

describe("WorkflowManager — assignment input for AssignDocumentsToGroups", () => {
  it("produces vendors + groups only for groups that have documents", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-full", label: "Has docs", vendorIds: ["v-acme"] });
    manager.createGroup({ id: "g-empty", label: "No docs yet", vendorIds: ["v-acme"] });
    manager.assignDocument("g-full", "doc-1");

    const built = manager.toAssignmentInput();
    expect(isOk(built)).toBe(true);
    if (!isOk(built)) return;
    expect(built.data.evaluationId).toBe("eval-1");
    expect(built.data.groups.map((group) => group.id)).toEqual(["g-full"]);
    expect(built.data.groups[0].documentIds).toEqual(["doc-1"]);
    expect(built.data.vendors.map((vendor) => vendor.id)).toEqual(["v-acme"]);
  });

  it("refuses to build an assignment when no group has a document", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-empty", label: "No docs", vendorIds: ["v-acme"] });

    const built = manager.toAssignmentInput();
    expect(isErr(built)).toBe(true);
  });
});

describe("WorkflowManager — stage advance eligibility", () => {
  it("cannot advance grouping → classifying until a group has documents", () => {
    const manager = managerWithDocuments();
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-1", label: "Bid 1", vendorIds: ["v-acme"] });

    expect(manager.canAdvance()).toBe(false);

    manager.assignDocument("g-1", "doc-1");
    expect(manager.canAdvance()).toBe(true);
    expect(manager.nextStage()).toBe("classifying");
  });
});
