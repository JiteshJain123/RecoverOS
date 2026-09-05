/**
 * Razorpay ADAPTER BOUNDARY.
 *
 * This is the ONLY module in the intelligence package that knows Razorpay-shaped
 * field names (`razorpay*`) and raw event strings. It translates a raw provider
 * record into the canonical, provider-agnostic {@link NormalizedPayment}. The
 * rest of the engine depends only on the canonical types.
 *
 * NOTE: this does NOT call the Razorpay API. It maps records that already exist
 * in our database (populated by webhooks/seed). No network, no SDK.
 */
import type {
  CanonicalEventType,
  CanonicalPaymentEvent,
  CanonicalPaymentStatus,
  NormalizedPayment,
} from "../domain/types";

/** A raw payment event as stored/received (provider vocabulary at the edge). */
export interface RawProviderPaymentEvent {
  /** Normalized category already assigned upstream (Prisma PaymentEventType). */
  type: string;
  /** The original provider event name, e.g. "payment.failed". */
  rawType: string;
  occurredAt: Date;
}

/** A raw payment record with provider-specific identifiers still attached. */
export interface RawProviderPayment {
  tenantId: string;
  id: string;
  customerId: string | null;

  razorpayPaymentId: string | null;
  razorpayOrderId: string | null;
  razorpayCustomerId: string | null;

  /** Prisma PaymentStatus string. */
  status: string;
  failureCode: string | null;
  failureReason: string | null;
  amountMinor: number;
  currency: string;

  capturedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  events: RawProviderPaymentEvent[];
}

/** A normalizer maps a raw provider record to the canonical representation. */
export interface PaymentNormalizer {
  normalize(raw: RawProviderPayment): NormalizedPayment;
}

const VALID_STATUS = new Set<CanonicalPaymentStatus>([
  "CREATED",
  "AUTHORIZED",
  "CAPTURED",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);

const VALID_EVENT_TYPE = new Set<CanonicalEventType>([
  "PAYMENT_CREATED",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_CAPTURED",
  "PAYMENT_FAILED",
  "REFUND_CREATED",
  "PAYMENT_LINK_CREATED",
  "PAYMENT_LINK_PAID",
  "PAYMENT_LINK_EXPIRED",
  "SUBSCRIPTION_CHARGED",
  "SUBSCRIPTION_FAILED",
  "OTHER",
]);

function toCanonicalStatus(status: string): CanonicalPaymentStatus {
  return VALID_STATUS.has(status as CanonicalPaymentStatus)
    ? (status as CanonicalPaymentStatus)
    : "CREATED";
}

function toCanonicalEventType(type: string): CanonicalEventType {
  return VALID_EVENT_TYPE.has(type as CanonicalEventType)
    ? (type as CanonicalEventType)
    : "OTHER";
}

/** Provider-neutral failure token: lower-cased/trimmed, provider prefixes removed. */
function normalizeFailureCode(code: string | null): string | null {
  if (code == null) return null;
  const trimmed = code.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Derive the failed-attempt count from the event history. Provider-agnostic:
 * counts canonical PAYMENT_FAILED / SUBSCRIPTION_FAILED events, and treats a
 * currently-FAILED payment as at least one attempt.
 */
function deriveRetryCount(
  status: CanonicalPaymentStatus,
  events: CanonicalPaymentEvent[],
): number {
  const failedEvents = events.filter(
    (e) => e.eventType === "PAYMENT_FAILED" || e.eventType === "SUBSCRIPTION_FAILED",
  ).length;
  if (failedEvents > 0) return failedEvents;
  return status === "FAILED" ? 1 : 0;
}

/**
 * Create the Razorpay→canonical normalizer. Stateless and deterministic.
 */
export function createRazorpayNormalizer(): PaymentNormalizer {
  return {
    normalize(raw: RawProviderPayment): NormalizedPayment {
      const status = toCanonicalStatus(raw.status);
      const events: CanonicalPaymentEvent[] = raw.events
        .map((e) => ({
          eventType: toCanonicalEventType(e.type),
          rawType: e.rawType,
          occurredAt: e.occurredAt,
        }))
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

      return {
        tenantId: raw.tenantId,
        paymentId: raw.id,
        customerId: raw.customerId,
        status,
        failureCode: normalizeFailureCode(raw.failureCode),
        failureReason: raw.failureReason,
        amountMinor: raw.amountMinor,
        currency: raw.currency,
        // Provider ids become opaque, provider-neutral references.
        paymentRef: raw.razorpayPaymentId,
        orderRef: raw.razorpayOrderId,
        customerRef: raw.razorpayCustomerId,
        createdAt: raw.createdAt,
        capturedAt: raw.capturedAt,
        updatedAt: raw.updatedAt,
        events,
        retryCount: deriveRetryCount(status, events),
      };
    },
  };
}
