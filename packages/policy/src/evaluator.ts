/**
 * Deterministic PolicyEvaluator — the single financial authorization gate.
 *
 * It takes a (already schema-validated) RecoveryPlan plus the tenant's case,
 * payment/customer context and applicable Policy, and returns an explainable
 * ALLOW / REVIEW / BLOCK decision. It is PURE: no network, no LLM, no clock reads
 * except the injected `now`, so the same inputs always yield the same decision
 * (testable, replayable, auditable).
 *
 * SECURITY INVARIANT: a strategy provider (Gemini or deterministic) may only
 * PROPOSE. Only this evaluator authorizes, and only an ALLOW (or an approved
 * REVIEW) may proceed to execution. Nothing here executes anything.
 *
 * Decision precedence: BLOCK dominates REVIEW dominates ALLOW. Every triggered
 * rule is recorded in `violatedRules` regardless of the final decision.
 */
import { STRATEGIES, type RecoveryPlan, type Strategy } from "@recoveros/strategy";
import {
  resolvePolicyConfig,
  type PolicyActionType,
  type PolicyConfig,
  type PolicyLimits,
} from "./config";

export type PolicyDecisionType = "ALLOW" | "REVIEW" | "BLOCK";

export interface PolicyDecision {
  decision: PolicyDecisionType;
  reason: string;
  violatedRules: string[];
  requiredApproval: boolean;
  maxAllowedAmountMinor: number;
  allowedActionTypes: PolicyActionType[];
  evaluatedAt: string;
  policyVersion: number | null;
}

/** Minimal case view the evaluator needs (provider-neutral). */
export interface PolicyCaseView {
  id: string;
  tenantId: string;
  status: string;
  rootCause: string | null;
  severity: string | null;
  amountAtRiskMinor: number;
  currency: string;
  /** Prior failed attempts on the underlying payment. */
  retryCount: number;
  /** When the case was opened (for age/expiry checks). */
  openedAt: Date;
  /** Explicit expiry, if the case carries one. */
  expiresAt?: Date | null;
}

/** Payment/customer context relevant to authorization. */
export interface PolicyPaymentContext {
  /** Canonical payment status; CAPTURED/REFUNDED ⇒ already recovered. */
  paymentStatus: string | null;
  /** True if the underlying payment has already been recovered. */
  alreadyRecovered: boolean;
  /** Idempotency keys already used by prior actions (duplicate guard). */
  usedIdempotencyKeys: readonly string[];
}

export interface PolicyEvaluationInput {
  tenant: { tenantId: string };
  case: PolicyCaseView;
  plan: RecoveryPlan;
  policy: { version: number | null; limits: PolicyLimits | null } | null;
  payment: PolicyPaymentContext;
  now: Date;
}

/** Case statuses that mean "stopped/terminal" — no execution may proceed. */
const STOPPED_STATUSES: ReadonlySet<string> = new Set([
  "REJECTED",
  "EXPIRED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
]);

const RECOVERED_STATUSES: ReadonlySet<string> = new Set(["CAPTURED", "REFUNDED", "PARTIALLY_REFUNDED"]);

const HOUR_MS = 3_600_000;

/** Map a plan strategy to the bounded RecoveryActionType a policy allow-lists. */
export function strategyToActionType(strategy: Strategy): PolicyActionType | null {
  switch (strategy) {
    case "RETRY_PAYMENT":
      return "RETRY_PAYMENT";
    case "SEND_PAYMENT_LINK":
    case "CHECKOUT_RECOVERY":
      return "SEND_PAYMENT_LINK";
    case "CUSTOMER_REMINDER":
      return "CONTACT_CUSTOMER";
    case "NO_ACTION":
      return "NO_ACTION";
    case "HUMAN_REVIEW":
      return null; // no executable action — always human review
    default:
      return null;
  }
}

interface RuleHit {
  rule: string;
  level: PolicyDecisionType; // REVIEW or BLOCK
  reason: string;
}

export class PolicyEvaluator {
  /**
   * Evaluate a plan against policy. Returns an explainable decision; never
   * throws for a "bad" plan — a bad plan simply BLOCKS.
   */
  evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const cfg = resolvePolicyConfig(input.policy?.limits ?? null);
    const policyVersion = input.policy?.version ?? null;
    const hits: RuleHit[] = [];

    const { plan, case: c, payment } = input;
    const strategy = plan.strategy;
    const actionType = strategyToActionType(strategy);

    // Largest amount any proposed action would move (0 for none).
    const actionAmountMinor = Math.max(
      0,
      ...plan.proposedActions.map((a) => a.amountMinor ?? 0),
      strategy === "NO_ACTION" || strategy === "HUMAN_REVIEW" ? 0 : c.amountAtRiskMinor,
    );

    // --- BLOCK rules -------------------------------------------------------

    // Unknown / unsupported strategy.
    if (!(STRATEGIES as readonly string[]).includes(strategy)) {
      hits.push({ rule: "unknown_strategy", level: "BLOCK", reason: `Unknown strategy "${strategy}".` });
    }

    // Already-recovered payment.
    if (payment.alreadyRecovered || RECOVERED_STATUSES.has(payment.paymentStatus ?? "")) {
      hits.push({ rule: "already_recovered", level: "BLOCK", reason: "Payment is already recovered." });
    }

    // Stopped/terminal case.
    if (STOPPED_STATUSES.has(c.status)) {
      hits.push({ rule: "stopped_case", level: "BLOCK", reason: `Case is stopped (${c.status}).` });
    }

    // Expired case (explicit expiry or age beyond the configured max).
    const ageHours = Math.max(0, (input.now.getTime() - c.openedAt.getTime()) / HOUR_MS);
    const explicitlyExpired = c.expiresAt ? input.now.getTime() > c.expiresAt.getTime() : false;
    if (explicitlyExpired || ageHours > cfg.maxCaseAgeHours) {
      hits.push({ rule: "expired_case", level: "BLOCK", reason: "Recovery case has expired." });
    }

    // Duplicate idempotency key (would double-execute).
    const dupeKey = plan.proposedActions.find((a) => payment.usedIdempotencyKeys.includes(a.idempotencyKey));
    if (dupeKey) {
      hits.push({
        rule: "duplicate_idempotency_key",
        level: "BLOCK",
        reason: `Idempotency key already used (${dupeKey.idempotencyKey}).`,
      });
    }

    // Action type outside the allowed list (NO_ACTION/HUMAN_REVIEW exempt).
    if (
      strategy !== "NO_ACTION" &&
      strategy !== "HUMAN_REVIEW" &&
      (actionType === null || !cfg.allowedActionTypes.includes(actionType))
    ) {
      hits.push({
        rule: "action_not_allowed",
        level: "BLOCK",
        reason: `Action ${actionType ?? "UNKNOWN"} is not in the allowed list.`,
      });
    }

    // Amount above the HARD ceiling.
    if (actionAmountMinor > cfg.maxAllowedAmountMinor) {
      hits.push({
        rule: "amount_above_max",
        level: "BLOCK",
        reason: `Amount ${actionAmountMinor} exceeds the max ${cfg.maxAllowedAmountMinor}.`,
      });
    }

    // Excessive retry count for a retry strategy.
    if (strategy === "RETRY_PAYMENT" && c.retryCount >= cfg.maxRetriesPerCase) {
      hits.push({
        rule: "excessive_retries",
        level: "BLOCK",
        reason: `Retry count ${c.retryCount} ≥ max ${cfg.maxRetriesPerCase}.`,
      });
    }

    // Missing evidence entirely (defence in depth; validated plans carry ≥1).
    if (plan.evidence.length === 0) {
      hits.push({ rule: "missing_evidence", level: "BLOCK", reason: "Plan carries no evidence." });
    }

    // --- REVIEW rules ------------------------------------------------------

    // The strategy itself asks for a human.
    if (strategy === "HUMAN_REVIEW") {
      hits.push({ rule: "human_review_strategy", level: "REVIEW", reason: "Strategy is HUMAN_REVIEW." });
    }

    // Low confidence.
    if (strategy !== "NO_ACTION" && plan.confidence < cfg.minConfidence) {
      hits.push({
        rule: "low_confidence",
        level: "REVIEW",
        reason: `Confidence ${plan.confidence} < ${cfg.minConfidence}.`,
      });
    }

    // High-risk plan/action.
    if (plan.riskLevel === "HIGH" || plan.riskLevel === "CRITICAL") {
      hits.push({ rule: "high_risk", level: "REVIEW", reason: `Risk level ${plan.riskLevel}.` });
    }

    // Amount in the review band (≤ max but ≥ review threshold).
    if (actionAmountMinor >= cfg.reviewAmountMinor && actionAmountMinor <= cfg.maxAllowedAmountMinor) {
      hits.push({
        rule: "amount_requires_review",
        level: "REVIEW",
        reason: `Amount ${actionAmountMinor} ≥ review threshold ${cfg.reviewAmountMinor}.`,
      });
    }

    // --- Combine -----------------------------------------------------------

    const hasBlock = hits.some((h) => h.level === "BLOCK");
    const hasReview = hits.some((h) => h.level === "REVIEW");
    const decision: PolicyDecisionType = hasBlock ? "BLOCK" : hasReview ? "REVIEW" : "ALLOW";

    const reason = hasBlock
      ? hits.find((h) => h.level === "BLOCK")!.reason
      : hasReview
        ? hits.find((h) => h.level === "REVIEW")!.reason
        : strategy === "NO_ACTION"
          ? "No action required; nothing to authorize."
          : "Within policy limits; authorized.";

    return {
      decision,
      reason,
      violatedRules: hits.map((h) => h.rule),
      requiredApproval: decision === "REVIEW",
      maxAllowedAmountMinor: cfg.maxAllowedAmountMinor,
      allowedActionTypes: cfg.allowedActionTypes,
      evaluatedAt: input.now.toISOString(),
      policyVersion,
    };
  }
}

export type { PolicyConfig };
