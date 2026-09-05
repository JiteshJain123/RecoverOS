/**
 * Deterministic root-cause classifier.
 *
 * Maps a canonical payment (its failure code/reason + event history) into the
 * small controlled {@link RootCause} taxonomy. Pure and deterministic — NO LLM,
 * no network, no clock. Same input → same class, every time.
 *
 * Matching strategy (first match wins, most specific first):
 *   1. exact failure-code token (e.g. "bank_timeout")
 *   2. keyword contained in the code or human reason (e.g. "timeout")
 *   3. structural signals from the event/status (expired link, abandonment)
 *   4. UNKNOWN fallback
 */
import { CLASSIFIER_VERSION } from "../config";
import type { NormalizedPayment, RootCause } from "./types";

export interface RootCauseResult {
  rootCause: RootCause;
  /** How the class was decided (for evidence/audit). */
  matchedBy: string;
  classifierVersion: string;
}

/** Exact provider-neutral failure tokens → root cause. */
const CODE_MAP: Record<string, RootCause> = {
  bank_timeout: "TIMEOUT",
  timeout: "TIMEOUT",
  insufficient_funds: "INSUFFICIENT_FUNDS",
  bank_declined: "BANK_DECLINE",
  bank_decline: "BANK_DECLINE",
  declined: "BANK_DECLINE",
  gateway_error: "GATEWAY_ERROR",
  checkout_abandoned: "CUSTOMER_ABANDONMENT",
  expired_payment_link: "EXPIRED_CHECKOUT",
  payment_link_expired: "EXPIRED_CHECKOUT",
};

/** Ordered keyword rules applied to code + reason text. */
const KEYWORD_RULES: ReadonlyArray<{ kw: string; cause: RootCause }> = [
  { kw: "insufficient", cause: "INSUFFICIENT_FUNDS" },
  { kw: "timeout", cause: "TIMEOUT" },
  { kw: "timed out", cause: "TIMEOUT" },
  { kw: "declin", cause: "BANK_DECLINE" }, // declined / decline
  { kw: "gateway", cause: "GATEWAY_ERROR" },
  { kw: "expired", cause: "EXPIRED_CHECKOUT" },
  { kw: "abandon", cause: "CUSTOMER_ABANDONMENT" },
];

/**
 * Classify the root cause of a payment's at-risk state.
 */
export function classifyRootCause(payment: NormalizedPayment): RootCauseResult {
  const version = CLASSIFIER_VERSION;
  const code = payment.failureCode?.toLowerCase() ?? null;
  const reason = payment.failureReason?.toLowerCase() ?? "";

  // 1. Exact code token.
  const exact = code ? CODE_MAP[code] : undefined;
  if (exact) {
    return { rootCause: exact, matchedBy: `code:${code}`, classifierVersion: version };
  }

  // 2. Keyword in code or reason.
  const haystack = `${code ?? ""} ${reason}`;
  for (const rule of KEYWORD_RULES) {
    if (haystack.includes(rule.kw)) {
      return { rootCause: rule.cause, matchedBy: `keyword:${rule.kw}`, classifierVersion: version };
    }
  }

  // 3. Structural signals from events/status.
  const hasExpiredLink = payment.events.some((e) => e.eventType === "PAYMENT_LINK_EXPIRED");
  if (hasExpiredLink) {
    return { rootCause: "EXPIRED_CHECKOUT", matchedBy: "event:PAYMENT_LINK_EXPIRED", classifierVersion: version };
  }
  const hasLinkCreated = payment.events.some((e) => e.eventType === "PAYMENT_LINK_CREATED");
  const captured = payment.events.some((e) => e.eventType === "PAYMENT_CAPTURED");
  if ((payment.status === "CREATED" || payment.status === "AUTHORIZED") && hasLinkCreated && !captured) {
    return { rootCause: "CUSTOMER_ABANDONMENT", matchedBy: "structural:pending_link_uncaptured", classifierVersion: version };
  }

  // 4. Fallback.
  return { rootCause: "UNKNOWN", matchedBy: "fallback", classifierVersion: version };
}
