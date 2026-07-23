// Procurement-evaluation domain error taxonomy. Mirrors Wayfinder's DomainError
// shape (ADR-001) so adapters can translate between the two without surprises,
// but is defined locally to keep redline-domain zero-dependency.
export type DomainErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "EXTRACTION_FAILED"
  | "CLASSIFICATION_FAILED"
  | "INFRA_FAILURE";

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export const domainError = (
  code: DomainErrorCode,
  message: string,
  cause?: unknown,
): DomainError => ({ code, message, cause });
