// @redline/redline-web — the specialist control surface (workflow manager) and
// the in-app review grid (Thread 11+). The workflow-manager core, its container
// wiring, and the view model are framework-free and unit-tested; a thin
// Next.js/React shell binds to them (matching Wayfinder's apps/web — ADR-0006),
// and a Playwright e2e (e2e/) proves the three relationship shapes compose and
// stages advance.
export {
  WorkflowManager,
  type WorkflowManagerInit,
  type WorkflowManagerGroup,
  type WorkflowManagerVendor,
  type WorkflowSnapshot,
} from "./lib/workflow-manager";

export {
  WorkflowController,
  buildContainer,
  type OpenWorkflowInput,
  type ProductionContainerParts,
  type WorkflowContainer,
} from "./lib/container";

export {
  renderWorkflowView,
  type GroupView,
  type WorkflowView,
} from "./lib/view";
