import {
  domainError,
  err,
  makeResponseGroup,
  makeVendor,
  nextIntakeStage,
  ok,
  type IntakeStage,
  type Result,
} from "@redline/redline-domain";
import type {
  AssignDocumentsToGroupsInput,
  ResponseGroupInput,
  VendorInput,
} from "@redline/redline-application";

// WorkflowManager — the specialist control surface's brain (build plan §5 /
/). A pure, in-memory model of the "drag documents into response
// groups" composition: it lets a specialist add vendors, create response groups,
// assign/move/unassign documents, mark consortiums, and split a vendor's
// multiple bids — the three relationship shapes the plan calls out. It holds no
// ports; the container renders its snapshot and, on advance, hands
// toAssignmentInput() to AssignDocumentsToGroups. Every invariant is checked
// through the same redline-domain smart constructors the use-case uses, so the
// UI never composes something the application layer would later reject.

export interface WorkflowManagerVendor {
  readonly id: string;
  readonly displayName: string;
  readonly isConsortium: boolean;
  readonly memberVendorIds: readonly string[];
}

export interface WorkflowManagerGroup {
  readonly id: string;
  readonly label: string;
  readonly vendorIds: readonly string[];
  readonly documentIds: readonly string[];
  readonly isConsortiumResponse: boolean;
}

export interface WorkflowSnapshot {
  readonly evaluationId: string;
  readonly stage: IntakeStage;
  readonly vendors: readonly WorkflowManagerVendor[];
  readonly groups: readonly WorkflowManagerGroup[];
  readonly unassignedDocumentIds: readonly string[];
  readonly canAdvance: boolean;
  readonly nextStage: IntakeStage | null;
}

export interface WorkflowManagerInit {
  readonly evaluationId: string;
  readonly stage: IntakeStage;
  readonly documentIds: readonly string[];
}

interface CreateGroupInput {
  readonly id: string;
  readonly label: string;
  readonly vendorIds: readonly string[];
}

interface MarkConsortiumInput {
  readonly id: string;
  readonly displayName: string;
  readonly memberVendorIds: readonly string[];
}

interface MutableVendor {
  id: string;
  displayName: string;
  isConsortium: boolean;
  memberVendorIds: string[];
}

interface MutableGroup {
  id: string;
  label: string;
  vendorIds: string[];
  documentIds: string[];
}

export class WorkflowManager {
  private readonly evaluationId: string;
  private readonly stage: IntakeStage;
  private readonly documentIds: readonly string[];
  private readonly vendors = new Map<string, MutableVendor>();
  private readonly groups = new Map<string, MutableGroup>();

  constructor(init: WorkflowManagerInit) {
    this.evaluationId = init.evaluationId;
    this.stage = init.stage;
    this.documentIds = [...init.documentIds];
  }

  addVendor(input: VendorInput): Result<WorkflowManagerVendor> {
    const vendor = makeVendor(input);
    if (vendor.error) return err(vendor.error);
    if (this.vendors.has(vendor.data.id)) {
      return err(domainError("VALIDATION_FAILED", `vendor ${vendor.data.id} already exists`));
    }

    const stored: MutableVendor = {
      id: vendor.data.id,
      displayName: vendor.data.displayName,
      isConsortium: vendor.data.isConsortium,
      memberVendorIds: [...vendor.data.memberVendorIds],
    };
    this.vendors.set(stored.id, stored);
    return ok(this.readVendor(stored));
  }

  createGroup(input: CreateGroupInput): Result<WorkflowManagerGroup> {
    const unknownVendor = input.vendorIds.find((vendorId) => !this.vendors.has(vendorId));
    if (unknownVendor) {
      return err(
        domainError("VALIDATION_FAILED", `group references unknown vendor ${unknownVendor}`),
      );
    }
    if (this.groups.has(input.id)) {
      return err(domainError("VALIDATION_FAILED", `group ${input.id} already exists`));
    }

    const label = input.label.trim();
    if (label === "") {
      return err(domainError("VALIDATION_FAILED", "response group label must not be blank"));
    }
    if (input.vendorIds.length === 0) {
      return err(domainError("VALIDATION_FAILED", "a response group must have at least one vendor"));
    }

    const stored: MutableGroup = {
      id: input.id,
      label,
      vendorIds: [...new Set(input.vendorIds)],
      documentIds: [],
    };
    this.groups.set(stored.id, stored);
    return ok(this.readGroup(stored));
  }

  assignDocument(groupId: string, documentId: string): Result<WorkflowManagerGroup> {
    const group = this.groups.get(groupId);
    if (!group) {
      return err(domainError("VALIDATION_FAILED", `unknown group ${groupId}`));
    }
    if (!this.documentIds.includes(documentId)) {
      return err(domainError("VALIDATION_FAILED", `unknown document ${documentId}`));
    }

    // A document belongs to exactly one response group; dropping it on a new
    // group moves it (build plan §5 — one response has N docs, a doc has one).
    for (const candidate of this.groups.values()) {
      candidate.documentIds = candidate.documentIds.filter((id) => id !== documentId);
    }
    group.documentIds.push(documentId);
    return ok(this.readGroup(group));
  }

  unassignDocument(documentId: string): void {
    for (const group of this.groups.values()) {
      group.documentIds = group.documentIds.filter((id) => id !== documentId);
    }
  }

  markConsortium(input: MarkConsortiumInput): Result<WorkflowManagerVendor> {
    const unknownMember = input.memberVendorIds.find((memberId) => !this.vendors.has(memberId));
    if (unknownMember) {
      return err(
        domainError("VALIDATION_FAILED", `consortium references unknown vendor ${unknownMember}`),
      );
    }

    const vendor = makeVendor({
      id: input.id,
      displayName: input.displayName,
      isConsortium: true,
      memberVendorIds: input.memberVendorIds,
    });
    if (vendor.error) return err(vendor.error);

    const stored: MutableVendor = {
      id: vendor.data.id,
      displayName: vendor.data.displayName,
      isConsortium: true,
      memberVendorIds: [...vendor.data.memberVendorIds],
    };
    this.vendors.set(stored.id, stored);
    return ok(this.readVendor(stored));
  }

  toAssignmentInput(): Result<AssignDocumentsToGroupsInput> {
    const populatedGroups = [...this.groups.values()].filter(
      (group) => group.documentIds.length > 0,
    );
    if (populatedGroups.length === 0) {
      return err(
        domainError("VALIDATION_FAILED", "assign at least one document to a group before advancing"),
      );
    }

    const groups: ResponseGroupInput[] = [];
    for (const group of populatedGroups) {
      // Re-check every group through the domain constructor so the UI can never
      // hand the use-case a shape it would reject.
      const validated = makeResponseGroup({ evaluationId: this.evaluationId, ...this.readGroup(group) });
      if (validated.error) return err(validated.error);
      groups.push({
        id: validated.data.id,
        label: validated.data.label,
        vendorIds: validated.data.vendorIds,
        documentIds: validated.data.documentIds,
      });
    }

    const referencedVendorIds = new Set(groups.flatMap((group) => group.vendorIds));
    const vendors: VendorInput[] = [...this.vendors.values()]
      .filter((vendor) => referencedVendorIds.has(vendor.id))
      .map((vendor) => ({
        id: vendor.id,
        displayName: vendor.displayName,
        isConsortium: vendor.isConsortium,
        memberVendorIds: vendor.memberVendorIds,
      }));

    return ok({ evaluationId: this.evaluationId, vendors, groups });
  }

  canAdvance(): boolean {
    if (nextIntakeStage(this.stage) === null) return false;
    return [...this.groups.values()].some((group) => group.documentIds.length > 0);
  }

  nextStage(): IntakeStage | null {
    return nextIntakeStage(this.stage);
  }

  snapshot(): WorkflowSnapshot {
    const assigned = new Set(
      [...this.groups.values()].flatMap((group) => group.documentIds),
    );
    return {
      evaluationId: this.evaluationId,
      stage: this.stage,
      vendors: [...this.vendors.values()].map((vendor) => this.readVendor(vendor)),
      groups: [...this.groups.values()].map((group) => this.readGroup(group)),
      unassignedDocumentIds: this.documentIds.filter((id) => !assigned.has(id)),
      canAdvance: this.canAdvance(),
      nextStage: this.nextStage(),
    };
  }

  private readVendor(vendor: MutableVendor): WorkflowManagerVendor {
    return {
      id: vendor.id,
      displayName: vendor.displayName,
      isConsortium: vendor.isConsortium,
      memberVendorIds: [...vendor.memberVendorIds],
    };
  }

  private readGroup(group: MutableGroup): WorkflowManagerGroup {
    return {
      id: group.id,
      label: group.label,
      vendorIds: [...group.vendorIds],
      documentIds: [...group.documentIds],
      isConsortiumResponse: group.vendorIds.length > 1,
    };
  }
}
