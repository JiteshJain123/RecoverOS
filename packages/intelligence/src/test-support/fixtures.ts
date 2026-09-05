/**
 * Deterministic test fixtures. No clock/RNG reads — every timestamp is a fixed
 * constant so tests are fully reproducible. Not exported from the package
 * barrel (test-only).
 */
import type { Clock } from "../engine/ports";
import type { RawProviderPayment, RawProviderPaymentEvent } from "../adapters/razorpay";

/** Fixed "now" used across the suites. */
export const NOW = new Date("2026-08-01T09:00:00.000Z");
export const fixedClock: Clock = { now: () => NOW };

/** A time offset helper relative to NOW. */
export const hoursBeforeNow = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

export function event(
  type: string,
  rawType: string,
  occurredAt: Date,
): RawProviderPaymentEvent {
  return { type, rawType, occurredAt };
}

let counter = 0;
/** Reset the fixture id counter (call in beforeEach if you need stable ids). */
export function resetIds(): void {
  counter = 0;
}

/**
 * Build a raw provider payment with sensible defaults. Override any field.
 * Defaults model a recent (1h old) payment so recency is high unless overridden.
 */
export function rawPayment(overrides: Partial<RawProviderPayment> = {}): RawProviderPayment {
  counter += 1;
  const id = overrides.id ?? `pay_${counter}`;
  const createdAt = overrides.createdAt ?? hoursBeforeNow(1);
  return {
    tenantId: overrides.tenantId ?? "tenant_a",
    id,
    customerId: overrides.customerId ?? "cust_1",
    razorpayPaymentId: overrides.razorpayPaymentId ?? `seed_rzp_payment_${id}`,
    razorpayOrderId: overrides.razorpayOrderId ?? `seed_rzp_order_${id}`,
    razorpayCustomerId: overrides.razorpayCustomerId ?? `seed_rzp_customer_${id}`,
    status: overrides.status ?? "FAILED",
    failureCode: overrides.failureCode ?? null,
    failureReason: overrides.failureReason ?? null,
    amountMinor: overrides.amountMinor ?? 500_000,
    currency: overrides.currency ?? "INR",
    capturedAt: overrides.capturedAt ?? null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    events: overrides.events ?? [event("PAYMENT_CREATED", "payment.created", createdAt)],
  };
}

/** A failed payment with a given failure code and N failure events. */
export function failedPayment(
  failureCode: string,
  opts: { attempts?: number; amountMinor?: number; tenantId?: string; id?: string } = {},
): RawProviderPayment {
  const attempts = opts.attempts ?? 1;
  const base = rawPayment({
    id: opts.id,
    tenantId: opts.tenantId,
    status: "FAILED",
    failureCode,
    failureReason: `Simulated ${failureCode}`,
    amountMinor: opts.amountMinor,
  });
  const events: RawProviderPaymentEvent[] = [
    event("PAYMENT_CREATED", "payment.created", hoursBeforeNow(attempts + 1)),
  ];
  for (let i = 0; i < attempts; i++) {
    events.push(event("PAYMENT_FAILED", "payment.failed", hoursBeforeNow(attempts - i)));
  }
  return { ...base, events };
}
