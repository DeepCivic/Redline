import { domainError } from "../errors/domain-error";
import { err, ok, type Result } from "../result";

// A vendor is either a single supplier or a consortium of two or more member
// vendors bidding together (build plan §5). memberVendorIds is only meaningful
// for consortiums; enforcing that invariant here keeps adapters honest.
export interface Vendor {
  readonly id: string;
  readonly displayName: string;
  readonly isConsortium: boolean;
  readonly memberVendorIds: readonly string[];
}

export interface MakeVendorInput {
  readonly id: string;
  readonly displayName: string;
  readonly isConsortium?: boolean;
  readonly memberVendorIds?: readonly string[];
}

const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

export const makeVendor = (input: MakeVendorInput): Result<Vendor> => {
  const displayName = input.displayName.trim();
  if (displayName === "") {
    return err(domainError("VALIDATION_FAILED", "vendor display name must not be blank"));
  }

  const isConsortium = input.isConsortium ?? false;
  const memberVendorIds = dedupe(input.memberVendorIds ?? []);

  if (isConsortium && memberVendorIds.length < 2) {
    return err(
      domainError("VALIDATION_FAILED", "a consortium must have at least two member vendors"),
    );
  }

  if (!isConsortium && memberVendorIds.length > 0) {
    return err(
      domainError("VALIDATION_FAILED", "a non-consortium vendor must not declare member vendors"),
    );
  }

  return ok({ id: input.id, displayName, isConsortium, memberVendorIds });
};

// A response group binds one or more vendors to the N documents that make up a
// single response. More than one vendor means a consortium response. One vendor
// may appear in multiple groups (multiple offerings). See build plan §5.
export interface ResponseGroup {
  readonly id: string;
  readonly evaluationId: string;
  readonly vendorIds: readonly string[];
  readonly label: string;
  readonly documentIds: readonly string[];
  readonly isConsortiumResponse: boolean;
}

export interface MakeResponseGroupInput {
  readonly id: string;
  readonly evaluationId: string;
  readonly vendorIds: readonly string[];
  readonly label: string;
  readonly documentIds: readonly string[];
}

export const makeResponseGroup = (
  input: MakeResponseGroupInput,
): Result<ResponseGroup> => {
  const label = input.label.trim();
  if (label === "") {
    return err(domainError("VALIDATION_FAILED", "response group label must not be blank"));
  }

  const vendorIds = dedupe(input.vendorIds);
  if (vendorIds.length === 0) {
    return err(domainError("VALIDATION_FAILED", "a response group must have at least one vendor"));
  }

  const documentIds = dedupe(input.documentIds);
  if (documentIds.length === 0) {
    return err(
      domainError("VALIDATION_FAILED", "a response group must have at least one document"),
    );
  }

  return ok({
    id: input.id,
    evaluationId: input.evaluationId,
    vendorIds,
    label,
    documentIds,
    isConsortiumResponse: vendorIds.length > 1,
  });
};

// The specialist-driven intake workflow, ordered from upload to sign-off
// (build plan §5). An evaluation may only advance one adjacent stage forward.
export const INTAKE_STAGES = [
  "documents_uploaded",
  "grouping",
  "classifying",
  "review",
  "finalised",
] as const;

export type IntakeStage = (typeof INTAKE_STAGES)[number];

export const nextIntakeStage = (stage: IntakeStage): IntakeStage | null => {
  const index = INTAKE_STAGES.indexOf(stage);
  const next = INTAKE_STAGES[index + 1];
  return next ?? null;
};

export const canAdvanceIntakeStage = (from: IntakeStage, to: IntakeStage): boolean =>
  nextIntakeStage(from) === to;
