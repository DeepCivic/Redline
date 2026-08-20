// redline's domain error taxonomy. Defined locally, because redline-domain takes
// no dependency on anything.
export type DomainErrorCode =
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "EXTRACTION_FAILED"
  | "INFRA_FAILURE"
  // A port operation that is deliberately declared but not yet built — a
  // deferral, not a runtime fault.
  | "NOT_IMPLEMENTED";

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
