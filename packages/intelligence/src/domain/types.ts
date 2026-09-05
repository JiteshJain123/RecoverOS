/**
 * Canonical, PROVIDER-AGNOSTIC domain types for payment intelligence.
 *
 * Nothing in this file (or anywhere the engine reasons over these types) may
 * assume Razorpay — or any specific PSP. Provider-specific field names
 * (`razorpay*`), raw event strings, and provider quirks are translated into
 * these canonical shapes at the ADAPTER boundary (see ../adapters/razorpay.ts)
 * and never leak past it. To add another PSP later, implement a new adapter
 * that produces these same types; the engine does not change.
 */

/** ISO-4217 currency code (e.g. "INR"). Kept as a string, provider-neutral. */
export type CurrencyCode = string;

/** Canonical payment lifecycle status (independent of any provider's naming). */
export type CanonicalPaymentStatus =
  | "CREATED"
  | "AUTHORIZED"
  | "CAPTURED"
  | "FAILED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

/** Canonical payment-event category (the raw provider string is kept as evidence only). */
export type CanonicalEventType =
  | "PAYMENT_CREATED"
  | "PAYMENT_AUTHORIZED"
  | "PAYMENT_CAPTURED"
  | "PAYMENT_FAILED"
  | "REFUND_CREATED"
  | "PAYMENT_LINK_CREATED"
  | "PAYMENT_LINK_PAID"
  | "PAYMENT_LINK_EXPIRED"
  | "SUBSCRIPTION_CHARGED"
  | "SUBSCRIPTION_FAILED"
  | "OTHER";

/**
 * The controlled root-cause taxonomy. Every raw failure/event is mapped into
 * exactly one of these by the deterministic classifier — never an LLM.
 * Mirrors the Prisma `RootCause` enum.
 */
export type RootCause =
  | "BANK_DECLINE"
  | "INSUFFICIENT_FUNDS"
  | "TIMEOUT"
  | "GATEWAY_ERROR"
  | "CUSTOMER_ABANDONMENT"
  | "EXPIRED_CHECKOUT"
  | "UNKNOWN";

/** Ordinal severity of a risk signal. */
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Numeric weight per severity, used by scoring and to pick a primary signal. */
export const SEVERITY_RANK: Record<Severity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/** The kinds of revenue-at-risk signal the detector can raise. */
export type SignalType =
  | "FAILED_PAYMENT"
  | "REPEATED_FAILURE"
  | "BANK_TIMEOUT"
  | "INSUFFICIENT_FUNDS"
  | "BANK_DECLINE"
  | "GATEWAY_ERROR"
  | "CHECKOUT_ABANDONMENT"
  | "EXPIRED_PAYMENT_LINK"
  | "PENDING_TIMEOUT";

/** A single canonical payment event. */
export interface CanonicalPaymentEvent {
  eventType: CanonicalEventType;
  /** Provider raw category retained purely as human/audit evidence. */
  rawType: string;
  occurredAt: Date;
}

/**
 * The canonical internal representation of a payment plus its events. This is
 * the ONLY payment shape the intelligence engine consumes. Provider ids are
 * carried as neutral `*Ref` fields — the engine treats them as opaque strings.
 */
export interface NormalizedPayment {
  tenantId: string;
  paymentId: string;
  customerId: string | null;

  status: CanonicalPaymentStatus;
  /** Provider-neutral, lower-cased failure token (e.g. "bank_timeout") or null. */
  failureCode: string | null;
  failureReason: string | null;

  amountMinor: number;
  currency: CurrencyCode;

  /** Opaque provider references, provider name intentionally not encoded here. */
  paymentRef: string | null;
  orderRef: string | null;
  customerRef: string | null;

  createdAt: Date;
  capturedAt: Date | null;
  updatedAt: Date;

  events: CanonicalPaymentEvent[];
  /** Number of failed attempts derived from events/status (>= 0). */
  retryCount: number;
}

/**
 * A detected revenue-at-risk signal. Every field required by the spec is
 * present so the API/dashboard can render and explain it without recomputation.
 */
export interface RiskSignal {
  type: SignalType;
  severity: Severity;
  /** Deterministic confidence in [0, 1]. Not a probability from a model. */
  confidence: number;
  /** Short human-readable explanation. */
  reason: string;
  /** Structured supporting evidence (codes, counts, ages, event names). */
  evidence: Record<string, unknown>;
  estimatedRevenueAtRiskMinor: number;
  currency: CurrencyCode;
  rootCause: RootCause;

  tenantId: string;
  paymentId: string;
  customerId: string | null;

  /** ISO-8601 timestamp of detection. */
  detectedAt: string;
  /** Identifies which rule produced this signal, and its version. */
  ruleId: string;
  ruleVersion: string;
}

/** One weighted input to the priority score, retained for explainability. */
export interface PriorityComponent {
  key: string;
  label: string;
  /** Normalized contribution input in [0, 1]. */
  value: number;
  /** Weight in [0, 1]; weights across components sum to 1. */
  weight: number;
  /** Points this component contributed to the 0–100 score (rounded). */
  contribution: number;
  /** Human-readable explanation of the raw input behind `value`. */
  detail: string;
}

/** The explainable priority score for a case. */
export interface PriorityScore {
  /** Final score in [0, 100]. */
  score: number;
  components: PriorityComponent[];
  formulaVersion: string;
}
