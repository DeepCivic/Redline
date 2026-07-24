// Pure domain ↔ redline_ row mapping. The one place the storage shape meets the
// domain entities, so repositories stay thin and this stays unit-testable with no
// DB. The load-bearing conversion is the currency figure: Postgres `numeric` is a
// decimal *string* on the wire, but the domain (and the review grid) needs a real
// number, so the write side stringifies and the read side parses.

import type { Evaluation } from "@redline/redline-domain";
import type {
  IntakeStage,
  ResponseGroup,
  Vendor,
} from "@redline/redline-domain";
import type { ProcurementResponse } from "@redline/redline-domain";
import type {
  EvaluationRow,
  NewEvaluationRow,
  NewResponseGroupRow,
  NewResponseRow,
  NewVendorRow,
  ResponseGroupRow,
  ResponseRow,
  VendorRow,
} from "./schema";

export const evaluationToRow = (evaluation: Evaluation): NewEvaluationRow => ({
  id: evaluation.id,
  name: evaluation.name,
  stage: evaluation.stage,
});

export const rowToEvaluation = (row: EvaluationRow): Evaluation => ({
  id: row.id,
  name: row.name,
  // The domain owns transition validation; the column just stores the value.
  stage: row.stage as IntakeStage,
});

export const vendorToRow = (evaluationId: string, vendor: Vendor): NewVendorRow => ({
  id: vendor.id,
  evaluationId,
  displayName: vendor.displayName,
  isConsortium: vendor.isConsortium,
  memberVendorIds: [...vendor.memberVendorIds],
});

export const rowToVendor = (row: VendorRow): Vendor => ({
  id: row.id,
  displayName: row.displayName,
  isConsortium: row.isConsortium,
  memberVendorIds: row.memberVendorIds,
});

export const responseGroupToRow = (group: ResponseGroup): NewResponseGroupRow => ({
  id: group.id,
  evaluationId: group.evaluationId,
  label: group.label,
  vendorIds: [...group.vendorIds],
  documentIds: [...group.documentIds],
  isConsortiumResponse: group.isConsortiumResponse,
});

export const rowToResponseGroup = (row: ResponseGroupRow): ResponseGroup => ({
  id: row.id,
  evaluationId: row.evaluationId,
  vendorIds: row.vendorIds,
  label: row.label,
  documentIds: row.documentIds,
  isConsortiumResponse: row.isConsortiumResponse,
});

// A ProcurementResponse has no id of its own in the domain; the repository mints
// one for the row (a deterministic composite would also work, but the caller owns
// identity here).
export const responseToRow = (
  id: string,
  response: ProcurementResponse,
): NewResponseRow => ({
  id,
  evaluationId: response.evaluationId,
  responseGroupId: response.responseGroupId,
  vendorName: response.vendorName,
  productName: response.productName,
  requirementId: response.requirementId,
  confidence: response.confidence,
  productSummary: response.productSummary,
  estimateAud:
    response.costing.estimateAud === null
      ? null
      : response.costing.estimateAud.toFixed(2),
  costDescription: response.costing.description,
  sourceDocumentId: response.source.documentId,
  sourceElementOrder: response.source.elementOrder,
  sourcePage: response.source.page,
  sourceChunkId: response.source.chunkId,
});

export const rowToResponse = (row: ResponseRow): ProcurementResponse => ({
  evaluationId: row.evaluationId,
  responseGroupId: row.responseGroupId,
  vendorName: row.vendorName,
  productName: row.productName,
  requirementId: row.requirementId,
  confidence: row.confidence,
  productSummary: row.productSummary,
  costing: {
    estimateAud: row.estimateAud === null ? null : Number(row.estimateAud),
    description: row.costDescription,
  },
  source: {
    documentId: row.sourceDocumentId,
    elementOrder: row.sourceElementOrder,
    page: row.sourcePage,
    chunkId: row.sourceChunkId,
  },
});
