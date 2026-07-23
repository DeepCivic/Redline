import { domainError } from "../errors/domain-error";
import { err, ok, type Result } from "../result";
import { isRequirementNumber, type RequirementNumber } from "./procurement-requirement";

// The user-defined categorisation captured alongside the fixed requirement.
// solutionScope applies to whole-solution-vs-component questions (e.g. req 1);
// userDefinedCategory carries the Numbatch user topic (e.g. req 6). Both optional.
export interface ResponseCategorisation {
  readonly solutionScope?: "whole_solution" | "component";
  readonly userDefinedCategory?: string;
}

// Costing satisfies the "dollar estimate OR short description" requirement:
// estimateAud is a real number when womblex/Numbatch found a figure, else null,
// and description carries the fallback prose. At least one must be present.
export interface ResponseCosting {
  readonly estimateAud: number | null;
  readonly description: string;
}

// Provenance back to the womblex extraction, so the review grid can deep-link to
// the exact document location (build plan §5). page/chunkId are nullable because
// not every element carries them.
export interface ResponseSource {
  readonly documentId: string;
  readonly elementOrder: number;
  readonly page: number | null;
  readonly chunkId: string | null;
}

export interface ProcurementResponse {
  readonly evaluationId: string;
  readonly responseGroupId: string;
  readonly vendorName: string;
  readonly productName: string;
  readonly requirementNumber: RequirementNumber;
  readonly categorisation: ResponseCategorisation;
  readonly productSummary: string;
  readonly costing: ResponseCosting;
  readonly source: ResponseSource;
}

export interface MakeProcurementResponseInput {
  readonly evaluationId: string;
  readonly responseGroupId: string;
  readonly vendorName: string;
  readonly productName: string;
  readonly requirementNumber: RequirementNumber;
  readonly categorisation?: ResponseCategorisation;
  readonly productSummary: string;
  readonly costing: { readonly estimateAud: number | null; readonly description: string };
  readonly source: {
    readonly documentId: string;
    readonly elementOrder: number;
    readonly page?: number | null;
    readonly chunkId?: string | null;
  };
}

const normaliseCategorisation = (
  categorisation: ResponseCategorisation | undefined,
): ResponseCategorisation => {
  if (!categorisation) return {};
  const userDefinedCategory = categorisation.userDefinedCategory?.trim();
  return {
    ...(categorisation.solutionScope ? { solutionScope: categorisation.solutionScope } : {}),
    ...(userDefinedCategory ? { userDefinedCategory } : {}),
  };
};

export const makeProcurementResponse = (
  input: MakeProcurementResponseInput,
): Result<ProcurementResponse> => {
  if (!isRequirementNumber(input.requirementNumber)) {
    return err(domainError("VALIDATION_FAILED", "response requirement number must be 1–6"));
  }

  const vendorName = input.vendorName.trim();
  if (vendorName === "") {
    return err(domainError("VALIDATION_FAILED", "vendor name must not be blank"));
  }

  const productName = input.productName.trim();
  if (productName === "") {
    return err(domainError("VALIDATION_FAILED", "product name must not be blank"));
  }

  const productSummary = input.productSummary.trim();
  if (productSummary === "") {
    return err(domainError("VALIDATION_FAILED", "product summary must not be blank"));
  }

  const estimateAud = input.costing.estimateAud;
  if (estimateAud !== null && (!Number.isFinite(estimateAud) || estimateAud < 0)) {
    return err(
      domainError("VALIDATION_FAILED", "cost estimate must be a non-negative number or null"),
    );
  }

  const costDescription = input.costing.description.trim();
  if (estimateAud === null && costDescription === "") {
    return err(
      domainError(
        "VALIDATION_FAILED",
        "costing must provide an estimate or a description fallback",
      ),
    );
  }

  const elementOrder = input.source.elementOrder;
  if (!Number.isInteger(elementOrder) || elementOrder < 0) {
    return err(
      domainError("VALIDATION_FAILED", "source element order must be a non-negative integer"),
    );
  }

  const documentId = input.source.documentId.trim();
  if (documentId === "") {
    return err(domainError("VALIDATION_FAILED", "source document id must not be blank"));
  }

  return ok({
    evaluationId: input.evaluationId,
    responseGroupId: input.responseGroupId,
    vendorName,
    productName,
    requirementNumber: input.requirementNumber,
    categorisation: normaliseCategorisation(input.categorisation),
    productSummary,
    costing: { estimateAud, description: costDescription },
    source: {
      documentId,
      elementOrder,
      page: input.source.page ?? null,
      chunkId: input.source.chunkId ?? null,
    },
  });
};
