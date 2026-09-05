/**
 * Deterministic idempotency-key generation for proposed recovery actions.
 *
 * An idempotency key guarantees a financial action executes AT MOST ONCE. The
 * key must therefore be:
 *   - deterministic: the same case state + action kind always yields the same
 *     key, so re-generating a plan for an unchanged case does not create a new,
 *     executable-again action; and
 *   - state-sensitive: a materially different attempt (e.g. after another failed
 *     retry) yields a different key, so a genuinely new attempt is allowed.
 *
 * No randomness, no clock reads — a pure function of its inputs (a 32-bit
 * FNV-1a hash rendered as hex). NOT a cryptographic hash; collision resistance
 * is not a security property here, only stable partitioning of intents.
 */
import { STRATEGY_RULES_VERSION } from "./config";
import type { ActionKind } from "./types";

/** FNV-1a (32-bit) over a UTF-8 string → 8-char lowercase hex. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash * 16777619, kept in 32-bit range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The stable facets of case state that define a distinct action attempt. */
export interface IdempotencyInput {
  tenantId: string;
  caseId: string;
  actionKind: ActionKind;
  rootCause: string | null;
  amountMinor: number;
  /** Attempt discriminator: another failure ⇒ a new, distinct retry. */
  retryCount: number;
}

/**
 * Build a deterministic idempotency key for a proposed action.
 * Shape: `rk_<caseId>_<ACTION>_<hash8>` (URL/opaque-safe).
 */
export function generateIdempotencyKey(input: IdempotencyInput): string {
  const canonical = [
    STRATEGY_RULES_VERSION,
    input.tenantId,
    input.caseId,
    input.actionKind,
    input.rootCause ?? "NONE",
    String(input.amountMinor),
    String(input.retryCount),
  ].join("|");
  return `rk_${input.caseId}_${input.actionKind}_${fnv1a(canonical)}`;
}
