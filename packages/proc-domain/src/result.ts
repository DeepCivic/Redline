import type { DomainError } from "./errors/domain-error";

// Result pattern at every boundary — no thrown exceptions cross the domain edge
// (mirrors Wayfinder ADR-001).
export type Result<T, E extends DomainError = DomainError> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: E };

export const ok = <T>(data: T): Result<T, never> => ({ data });

export const err = <E extends DomainError>(error: E): Result<never, E> => ({ error });

export const isOk = <T, E extends DomainError>(
  result: Result<T, E>,
): result is { data: T; error?: undefined } => result.error === undefined;

export const isErr = <T, E extends DomainError>(
  result: Result<T, E>,
): result is { data?: undefined; error: E } => result.error !== undefined;
