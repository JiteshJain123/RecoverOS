/**
 * Deterministic configuration for the payment-intelligence engine.
 *
 * Every tunable lives here as a constant so behaviour is reproducible and the
 * ruleset can be versioned. Changing a threshold/weight is a deliberate,
 * reviewable act — and the version strings below flow into audit records so it
 * is always clear which ruleset produced a given signal/case.
 */

/** Version stamps recorded on signals, scores and audit entries. */
export const CLASSIFIER_VERSION = "rootcause-v1";
export const DETECTION_RULES_VERSION = "detect-v1";
export const SCORING_FORMULA_VERSION = "priority-v1";

/** Detection thresholds. */
export const THRESHOLDS = {
  /** A payment is a "repeated failure" at or above this many failed attempts. */
  repeatedFailureMinAttempts: 2,
  /** A CREATED/AUTHORIZED payment older than this many hours is "pending too long". */
  pendingTimeoutHours: 24,
  /** Amount (minor units) at/above which a signal escalates one severity step. */
  highAmountMinor: 1_000_000, // ₹10,000
  /** Amount (minor units) at/above which a signal escalates to CRITICAL territory. */
  criticalAmountMinor: 2_000_000, // ₹20,000
} as const;

/** Weights for the explainable priority score. MUST sum to 1. */
export const SCORE_WEIGHTS = {
  amount: 0.35,
  severity: 0.25,
  retry: 0.15,
  recency: 0.15,
  customer: 0.1,
} as const;

/** Normalization caps for score inputs. */
export const SCORE_NORMALIZERS = {
  /** Amount (minor units) that maps to a full amount-component (value = 1). */
  amountCapMinor: 2_000_000, // ₹20,000
  /** Retry attempts that map to a full retry-component (value = 1). */
  retryCap: 3,
  /** Age (hours) at which the recency component decays to 0. */
  recencyDecayHours: 72,
  /** Captured-payment count that maps to a full customer-history component. */
  customerHistoryCap: 5,
} as const;

// Compile-time-ish guard: keep the weights honest.
const WEIGHT_SUM = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(`SCORE_WEIGHTS must sum to 1 (got ${WEIGHT_SUM}).`);
}
