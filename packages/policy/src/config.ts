/**
 * Policy configuration.
 *
 * Thresholds are resolved from a tenant's active `Policy.limits` JSON wherever
 * practical, falling back to conservative defaults. This keeps financial safety
 * controls DATA-DRIVEN (a merchant tunes them via Policy records) rather than
 * hardcoded in the evaluator.
 *
 * The shape mirrors the seeded Policy.limits:
 *   { maxRetryAmountMinor, maxRetriesPerCase, cooldownHours, contactCapPerDay,
 *     allowedActions, rollingDailyCapMinor }
 * plus optional review-tuning fields (minConfidence, reviewAmountMinor,
 * maxCaseAgeHours) that a policy may set to override defaults.
 */

/** Bounded action types a policy may permit (mirrors Prisma RecoveryActionType). */
export type PolicyActionType = "RETRY_PAYMENT" | "SEND_PAYMENT_LINK" | "CONTACT_CUSTOMER" | "NO_ACTION";

/** Raw, untrusted limits blob as stored on a Policy record. */
export interface PolicyLimits {
  maxRetryAmountMinor?: number;
  maxRetriesPerCase?: number;
  cooldownHours?: number;
  contactCapPerDay?: number;
  allowedActions?: string[];
  rollingDailyCapMinor?: number;
  /** Optional review-tuning overrides. */
  minConfidence?: number;
  reviewAmountMinor?: number;
  maxCaseAgeHours?: number;
  [key: string]: unknown;
}

/** Fully-resolved, validated configuration the evaluator reasons over. */
export interface PolicyConfig {
  /** Hard ceiling: an action amount above this is BLOCKED outright. */
  maxAllowedAmountMinor: number;
  /** Soft ceiling: at/above this (but ≤ max) an action needs human REVIEW. */
  reviewAmountMinor: number;
  /** Confidence below this routes to REVIEW. */
  minConfidence: number;
  /** Max prior failed attempts before a retry is BLOCKED (excessive retries). */
  maxRetriesPerCase: number;
  /** A case older than this many hours is treated as expired → BLOCK. */
  maxCaseAgeHours: number;
  /** The action types this policy permits; anything else is BLOCKED. */
  allowedActionTypes: PolicyActionType[];
  /** Optional rolling daily spend ceiling (minor units); 0 disables. */
  rollingDailyCapMinor: number;
}

/** Conservative defaults used when a policy omits a field (or there is no policy). */
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  maxAllowedAmountMinor: 2_000_000, // ₹20,000 hard ceiling
  reviewAmountMinor: 1_000_000, // ₹10,000 review threshold
  minConfidence: 0.5,
  maxRetriesPerCase: 2,
  maxCaseAgeHours: 30 * 24, // 30 days
  allowedActionTypes: ["RETRY_PAYMENT", "NO_ACTION"],
  rollingDailyCapMinor: 0,
};

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "RETRY_PAYMENT",
  "SEND_PAYMENT_LINK",
  "CONTACT_CUSTOMER",
  "NO_ACTION",
]);

/**
 * Resolve a `PolicyConfig` from a tenant's active Policy limits (if any),
 * overlaying defaults. NO_ACTION is always permitted (it executes nothing).
 */
export function resolvePolicyConfig(limits: PolicyLimits | null | undefined): PolicyConfig {
  const l = limits ?? {};
  const maxAllowedAmountMinor = num(l.maxRetryAmountMinor, DEFAULT_POLICY_CONFIG.maxAllowedAmountMinor);
  const reviewAmountMinor = Math.min(
    num(l.reviewAmountMinor, Math.floor(maxAllowedAmountMinor * 0.5)),
    maxAllowedAmountMinor,
  );

  const allowed = Array.isArray(l.allowedActions)
    ? l.allowedActions.filter((a): a is PolicyActionType => VALID_ACTIONS.has(a))
    : DEFAULT_POLICY_CONFIG.allowedActionTypes;
  // NO_ACTION is always allowed (a decision to do nothing is never blocked).
  const allowedActionTypes = Array.from(new Set<PolicyActionType>([...allowed, "NO_ACTION"]));

  return {
    maxAllowedAmountMinor,
    reviewAmountMinor,
    minConfidence: Math.min(1, Math.max(0, num(l.minConfidence, DEFAULT_POLICY_CONFIG.minConfidence))),
    maxRetriesPerCase: num(l.maxRetriesPerCase, DEFAULT_POLICY_CONFIG.maxRetriesPerCase),
    maxCaseAgeHours: num(l.maxCaseAgeHours, DEFAULT_POLICY_CONFIG.maxCaseAgeHours),
    allowedActionTypes,
    rollingDailyCapMinor: num(l.rollingDailyCapMinor, DEFAULT_POLICY_CONFIG.rollingDailyCapMinor),
  };
}
