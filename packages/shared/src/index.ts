/**
 * @recoveros/shared
 *
 * Cross-cutting types and small pure utilities shared across packages and apps.
 * No runtime dependencies. Keep this package free of framework/vendor code.
 */

/** Branded id types for clarity at boundaries (not enforced at runtime yet). */
export type TenantId = string & { readonly __brand: "TenantId" };
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type UserId = string & { readonly __brand: "UserId" };

/** Roles used by RBAC (see docs/ARCHITECTURE.md §4). */
export const ROLES = ["owner", "admin", "approver", "analyst", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** A minimal discriminated-union result type for fallible operations. */
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** Standard shape returned by health endpoints across services. */
export interface HealthStatus {
  status: "ok";
  service: string;
  timestamp: string;
}
