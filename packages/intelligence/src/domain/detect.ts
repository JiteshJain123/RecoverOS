/**
 * Deterministic revenue-at-risk detection.
 *
 * Given a canonical payment, emit zero or more {@link RiskSignal}s. Pure and
 * deterministic: the only "current time" used is the injected `now`, so results
 * are fully reproducible in tests. NO LLM, no network, no randomness.
 *
 * Each rule is small, independent, and self-explaining (it fills `reason` and
 * `evidence`). A payment may trigger several rules (e.g. a repeated bank
 * timeout raises FAILED_PAYMENT + REPEATED_FAILURE + BANK_TIMEOUT); the engine
 * later picks a primary signal for the recovery case.
 */
import { DETECTION_RULES_VERSION, THRESHOLDS } from "../config";
import { classifyRootCause } from "./classify";
import type { NormalizedPayment, RiskSignal, RootCause, Severity, SignalType } from "./types";
import { SEVERITY_RANK } from "./types";

export interface DetectContext {
  now: Date;
}

const HOUR_MS = 3_600_000;

/** Escalate a base severity by amount at risk (deterministic thresholds). */
function severityForAmount(base: Severity, amountMinor: number): Severity {
  let rank = SEVERITY_RANK[base];
  if (amountMinor >= THRESHOLDS.criticalAmountMinor) rank += 2;
  else if (amountMinor >= THRESHOLDS.highAmountMinor) rank += 1;
  const clamped = Math.min(4, Math.max(1, rank));
  return (["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const)[clamped - 1] ?? base;
}

function ageHours(now: Date, from: Date): number {
  return Math.max(0, (now.getTime() - from.getTime()) / HOUR_MS);
}

/** Small helper to assemble a signal with the shared/boilerplate fields filled. */
function makeSignal(
  p: NormalizedPayment,
  ctx: DetectContext,
  fields: {
    type: SignalType;
    ruleId: string;
    severity: Severity;
    confidence: number;
    reason: string;
    evidence: Record<string, unknown>;
    estimatedRevenueAtRiskMinor: number;
    rootCause: RootCause;
  },
): RiskSignal {
  return {
    type: fields.type,
    severity: fields.severity,
    confidence: fields.confidence,
    reason: fields.reason,
    evidence: fields.evidence,
    estimatedRevenueAtRiskMinor: fields.estimatedRevenueAtRiskMinor,
    currency: p.currency,
    rootCause: fields.rootCause,
    tenantId: p.tenantId,
    paymentId: p.paymentId,
    customerId: p.customerId,
    detectedAt: ctx.now.toISOString(),
    ruleId: fields.ruleId,
    ruleVersion: DETECTION_RULES_VERSION,
  };
}

/**
 * Run every detection rule over one payment and return the signals raised.
 */
export function detectSignals(p: NormalizedPayment, ctx: DetectContext): RiskSignal[] {
  const signals: RiskSignal[] = [];
  const { rootCause } = classifyRootCause(p);
  const isFailed = p.status === "FAILED";
  const isPending = p.status === "CREATED" || p.status === "AUTHORIZED";
  const captured = p.status === "CAPTURED";
  const hasExpiredLinkEvent = p.events.some((e) => e.eventType === "PAYMENT_LINK_EXPIRED");

  // Rule: generic failed payment.
  if (isFailed) {
    signals.push(
      makeSignal(p, ctx, {
        type: "FAILED_PAYMENT",
        ruleId: "failed_payment",
        severity: severityForAmount("MEDIUM", p.amountMinor),
        confidence: 0.99,
        reason: "Payment is in a FAILED state; the associated revenue is at risk.",
        evidence: { status: p.status, failureCode: p.failureCode, amountMinor: p.amountMinor },
        estimatedRevenueAtRiskMinor: p.amountMinor,
        rootCause,
      }),
    );
  }

  // Rule: repeated failure (multiple failed attempts).
  if (p.retryCount >= THRESHOLDS.repeatedFailureMinAttempts) {
    signals.push(
      makeSignal(p, ctx, {
        type: "REPEATED_FAILURE",
        ruleId: "repeated_failure",
        severity: severityForAmount("HIGH", p.amountMinor),
        confidence: 0.95,
        reason: `Payment failed ${p.retryCount} times; repeated failure lowers organic recovery odds.`,
        evidence: { retryCount: p.retryCount, threshold: THRESHOLDS.repeatedFailureMinAttempts },
        estimatedRevenueAtRiskMinor: p.amountMinor,
        rootCause,
      }),
    );
  }

  // Cause-specific failure rules (only meaningful for failed payments).
  if (isFailed) {
    const causeRules: Partial<Record<RootCause, { type: SignalType; ruleId: string; reason: string }>> = {
      TIMEOUT: {
        type: "BANK_TIMEOUT",
        ruleId: "bank_timeout",
        reason: "Issuing bank timed out; a transient failure that often succeeds on retry.",
      },
      INSUFFICIENT_FUNDS: {
        type: "INSUFFICIENT_FUNDS",
        ruleId: "insufficient_funds",
        reason: "Declined for insufficient funds; recovery favours a delayed retry or a payment link.",
      },
      BANK_DECLINE: {
        type: "BANK_DECLINE",
        ruleId: "bank_decline",
        reason: "Issuing bank declined the charge; may need an alternate method.",
      },
      GATEWAY_ERROR: {
        type: "GATEWAY_ERROR",
        ruleId: "gateway_error",
        reason: "Gateway error during processing; typically transient and retryable.",
      },
    };
    const rule = causeRules[rootCause];
    if (rule) {
      // Timeout/gateway are transient (high retry confidence); decline/NSF less so.
      const transient = rootCause === "TIMEOUT" || rootCause === "GATEWAY_ERROR";
      signals.push(
        makeSignal(p, ctx, {
          type: rule.type,
          ruleId: rule.ruleId,
          severity: severityForAmount(transient ? "MEDIUM" : "HIGH", p.amountMinor),
          confidence: transient ? 0.9 : 0.85,
          reason: rule.reason,
          evidence: { failureCode: p.failureCode, rootCause, transient },
          estimatedRevenueAtRiskMinor: p.amountMinor,
          rootCause,
        }),
      );
    }
  }

  // Rule: expired payment link.
  if (hasExpiredLinkEvent || rootCause === "EXPIRED_CHECKOUT") {
    signals.push(
      makeSignal(p, ctx, {
        type: "EXPIRED_PAYMENT_LINK",
        ruleId: "expired_payment_link",
        severity: severityForAmount("MEDIUM", p.amountMinor),
        confidence: 0.9,
        reason: "A payment link expired before the customer paid; a fresh link may recover it.",
        evidence: {
          expiredLinkEvent: hasExpiredLinkEvent,
          failureCode: p.failureCode,
        },
        estimatedRevenueAtRiskMinor: p.amountMinor,
        rootCause: "EXPIRED_CHECKOUT",
      }),
    );
  }

  // Rule: checkout abandonment (pending, link created, never captured, not expired).
  if (isPending && rootCause === "CUSTOMER_ABANDONMENT" && !hasExpiredLinkEvent && !captured) {
    signals.push(
      makeSignal(p, ctx, {
        type: "CHECKOUT_ABANDONMENT",
        ruleId: "checkout_abandonment",
        severity: severityForAmount("MEDIUM", p.amountMinor),
        confidence: 0.8,
        reason: "Customer left checkout without completing payment; a nudge may recover it.",
        evidence: { status: p.status, failureCode: p.failureCode },
        estimatedRevenueAtRiskMinor: p.amountMinor,
        rootCause: "CUSTOMER_ABANDONMENT",
      }),
    );
  }

  // Rule: pending payment that has exceeded the age threshold.
  if (isPending && !captured) {
    const age = ageHours(ctx.now, p.createdAt);
    if (age >= THRESHOLDS.pendingTimeoutHours) {
      signals.push(
        makeSignal(p, ctx, {
          type: "PENDING_TIMEOUT",
          ruleId: "pending_timeout",
          severity: severityForAmount("LOW", p.amountMinor),
          confidence: 0.7,
          reason: `Payment has been pending for ${Math.floor(age)}h (> ${THRESHOLDS.pendingTimeoutHours}h) without capture.`,
          evidence: {
            ageHours: Math.floor(age),
            thresholdHours: THRESHOLDS.pendingTimeoutHours,
            status: p.status,
          },
          estimatedRevenueAtRiskMinor: p.amountMinor,
          rootCause: rootCause === "UNKNOWN" ? "CUSTOMER_ABANDONMENT" : rootCause,
        }),
      );
    }
  }

  return signals;
}

/** Deterministically pick the "primary" signal: highest severity, then amount, then rule id. */
export function primarySignal(signals: RiskSignal[]): RiskSignal | null {
  if (signals.length === 0) return null;
  return [...signals].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const amt = b.estimatedRevenueAtRiskMinor - a.estimatedRevenueAtRiskMinor;
    if (amt !== 0) return amt;
    return a.ruleId.localeCompare(b.ruleId);
  })[0] as RiskSignal;
}
