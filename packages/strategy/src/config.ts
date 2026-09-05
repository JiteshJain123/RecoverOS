/**
 * Deterministic configuration for the Recovery Strategy Engine.
 *
 * Every tunable lives here as a constant so the deterministic provider is fully
 * reproducible and the ruleset can be versioned. The version string flows into
 * every RecoveryPlan's `modelMetadata` and into audit records, so it is always
 * clear which ruleset produced a given plan.
 *
 * NOTE ON CAPABILITIES: a strategy is NOT the same as an executable action, and
 * an action is NOT assumed to be executable by any particular provider. Each
 * proposed action declares the provider `capability` it would require. The
 * payments adapter (a later phase) advertises which capabilities it actually
 * supports; the deterministic policy engine authorizes; only then can an action
 * reach a provider. Nothing here executes anything.
 */

/** Version stamp recorded on every deterministic plan and audit entry. */
export const STRATEGY_RULES_VERSION = "strategy-rules-v1";

/** Provider capability tokens an action would require to execute. */
export const CAPABILITY = {
  /** Re-attempt the original charge on the original instrument. */
  RETRY_PAYMENT: "payment.retry",
  /** Create a fresh hosted payment link / checkout. */
  CREATE_PAYMENT_LINK: "payment_link.create",
  /** Send a customer-facing message (email/SMS/etc.). */
  NOTIFY_CUSTOMER: "customer.notify",
  /** Internal-only: route to a human queue. Always available (no provider). */
  HUMAN_REVIEW: "internal.review",
  /** No capability required (a no-op action). */
  NONE: "none",
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

/** Deterministic thresholds used by the strategy rules. */
export const STRATEGY_THRESHOLDS = {
  /** At/above this many prior failed attempts a failure counts as "repeated". */
  repeatedFailureMinAttempts: 2,
  /**
   * Hard cap on automated payment retries. At/above this the engine stops
   * proposing retries and routes to HUMAN_REVIEW (retry-cap stopping condition).
   */
  maxRetryAttempts: 3,
} as const;

/** Time-to-live (seconds) for actions that must not linger. */
export const TTL_SECONDS = {
  /** A proposed retry should be authorized+executed within this window. */
  retry: 24 * 3600,
  /** A fresh payment link should expire after this window. */
  paymentLink: 72 * 3600,
  /** A customer reminder is only relevant for this window. */
  reminder: 48 * 3600,
} as const;
