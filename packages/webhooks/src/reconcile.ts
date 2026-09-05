/**
 * Canonical payment-state reconciliation, robust to OUT-OF-ORDER delivery.
 *
 * Razorpay does not guarantee ordering: `payment.captured` may arrive before
 * `payment.authorized`. We assign each canonical status a monotonic rank and
 * only ever ADVANCE the payment's status (never downgrade), so a late
 * `authorized` can never clobber a `captured`. A refund is always applied on top
 * of a captured payment.
 *
 * We also map each webhook event to the canonical status it asserts and to our
 * internal PaymentEventType.
 */

/** Canonical payment status (mirrors Prisma PaymentStatus). */
export type CanonicalStatus =
  | "CREATED"
  | "AUTHORIZED"
  | "CAPTURED"
  | "FAILED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

/** Internal event category (mirrors Prisma PaymentEventType). */
export type InternalEventType =
  | "PAYMENT_AUTHORIZED"
  | "PAYMENT_CAPTURED"
  | "PAYMENT_FAILED"
  | "REFUND_CREATED"
  | "OTHER";

/** Higher rank = more advanced/terminal; status only ever advances. */
const RANK: Record<CanonicalStatus, number> = {
  CREATED: 0,
  AUTHORIZED: 1,
  FAILED: 2,
  CAPTURED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
};

export function statusRank(status: CanonicalStatus): number {
  return RANK[status];
}

/** Whether moving from `current` to `next` is a forward (allowed) transition. */
export function advances(current: CanonicalStatus | null, next: CanonicalStatus): boolean {
  if (current === null) return true;
  return RANK[next] > RANK[current];
}

export interface EventMapping {
  /** The canonical status this event asserts for the payment. */
  status: CanonicalStatus | null;
  /** Our internal PaymentEvent type. */
  internalType: InternalEventType;
}

/** Map a Razorpay webhook event type to canonical status + internal type. */
export function mapEvent(eventType: string): EventMapping {
  switch (eventType) {
    case "payment.authorized":
      return { status: "AUTHORIZED", internalType: "PAYMENT_AUTHORIZED" };
    case "payment.captured":
      return { status: "CAPTURED", internalType: "PAYMENT_CAPTURED" };
    case "order.paid":
      // The order is paid → the associated payment is captured.
      return { status: "CAPTURED", internalType: "PAYMENT_CAPTURED" };
    case "payment.failed":
      return { status: "FAILED", internalType: "PAYMENT_FAILED" };
    case "payment.refunded":
      return { status: "REFUNDED", internalType: "REFUND_CREATED" };
    case "payment.partially_refunded":
      return { status: "PARTIALLY_REFUNDED", internalType: "REFUND_CREATED" };
    default:
      return { status: null, internalType: "OTHER" };
  }
}
