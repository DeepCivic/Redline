import { describe, it, expect } from "vitest";
import { renderWorkflowView } from "./view";
import { WorkflowManager } from "./workflow-manager";

// The view is a pure snapshot → view-model transform: the Next.js/React layer
// binds to this, so the presentation logic (labels, the advance affordance, the
// document tray) is unit-testable without a browser. The Playwright e2e proves
// the DOM wiring; this proves the model the DOM binds to.

describe("renderWorkflowView", () => {
  it("shows the unassigned tray and per-group document counts", () => {
    const manager = new WorkflowManager({
      evaluationId: "eval-1",
      stage: "grouping",
      documentIds: ["doc-1", "doc-2", "doc-3"],
    });
    manager.addVendor({ id: "v-acme", displayName: "Acme" });
    manager.createGroup({ id: "g-acme", label: "Acme Bid", vendorIds: ["v-acme"] });
    manager.assignDocument("g-acme", "doc-1");

    const view = renderWorkflowView(manager.snapshot());

    expect(view.stageLabel).toBe("Grouping");
    expect(view.tray.documentIds).toEqual(["doc-2", "doc-3"]);
    expect(view.groups).toHaveLength(1);
    expect(view.groups[0].title).toBe("Acme Bid");
    expect(view.groups[0].documentCount).toBe(1);
    expect(view.groups[0].consortiumBadge).toBe(false);
    expect(view.advance.enabled).toBe(true);
    expect(view.advance.label).toBe("Advance to Classifying");
  });

  it("marks a consortium group and disables advance with no assigned documents", () => {
    const manager = new WorkflowManager({
      evaluationId: "eval-1",
      stage: "grouping",
      documentIds: ["doc-1"],
    });
    manager.addVendor({ id: "v-a", displayName: "Alpha" });
    manager.addVendor({ id: "v-b", displayName: "Beta" });
    manager.createGroup({ id: "g-jv", label: "JV Bid", vendorIds: ["v-a", "v-b"] });

    const view = renderWorkflowView(manager.snapshot());

    expect(view.groups[0].consortiumBadge).toBe(true);
    expect(view.advance.enabled).toBe(false);
    expect(view.advance.label).toBe("Assign a document to advance");
  });
});
