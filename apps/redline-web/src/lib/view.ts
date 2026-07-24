import type { IntakeStage } from "@redline/redline-domain";
import type { WorkflowSnapshot } from "./workflow-manager";

// View model for the specialist control surface. A pure transform of a
// WorkflowManager snapshot into presentation-ready shapes; the HTML/SvelteKit
// layer binds to this, keeping the DOM dumb and the labels/affordances tested.

const STAGE_LABELS: Record<IntakeStage, string> = {
  documents_uploaded: "Documents uploaded",
  grouping: "Grouping",
  classifying: "Classifying",
  review: "Review",
  finalised: "Finalised",
};

export interface GroupView {
  readonly id: string;
  readonly title: string;
  readonly vendorIds: readonly string[];
  readonly documentIds: readonly string[];
  readonly documentCount: number;
  readonly consortiumBadge: boolean;
}

export interface WorkflowView {
  readonly stageLabel: string;
  readonly tray: { readonly documentIds: readonly string[] };
  readonly groups: readonly GroupView[];
  readonly advance: { readonly enabled: boolean; readonly label: string };
}

export const renderWorkflowView = (snapshot: WorkflowSnapshot): WorkflowView => {
  const advanceLabel =
    snapshot.canAdvance && snapshot.nextStage
      ? `Advance to ${STAGE_LABELS[snapshot.nextStage]}`
      : "Assign a document to advance";

  return {
    stageLabel: STAGE_LABELS[snapshot.stage],
    tray: { documentIds: snapshot.unassignedDocumentIds },
    groups: snapshot.groups.map((group) => ({
      id: group.id,
      title: group.label,
      vendorIds: group.vendorIds,
      documentIds: group.documentIds,
      documentCount: group.documentIds.length,
      consortiumBadge: group.isConsortiumResponse,
    })),
    advance: { enabled: snapshot.canAdvance, label: advanceLabel },
  };
};
