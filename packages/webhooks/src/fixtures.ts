/**
 * Development webhook fixture generator / replay harness.
 *
 * Builds realistic Razorpay webhook payloads for each supported event and signs
 * them with a TEST secret, so we can replay locally (or in tests) WITHOUT calling
 * Razorpay or any third-party service. Everything is synthetic: ids are
 * `seed_*`/`acc_test_*` and no real money or customer data is involved.
 */
import { computeSignature } from "./signature";
import type { SupportedEvent } from "./razorpay-schemas";

export interface FixtureOptions {
  accountId?: string;
  paymentId?: string;
  orderId?: string;
  amountMinor?: number;
  currency?: string;
  method?: string;
  failureCode?: string;
  failureReason?: string;
  createdAt?: number;
  eventId?: string;
}

export interface WebhookFixture {
  /** The exact raw body to POST (sign THIS, do not re-stringify). */
  rawBody: string;
  signature: string;
  eventId: string;
  accountId: string;
  body: Record<string, unknown>;
}

function paymentEntity(status: string, o: Required<Pick<FixtureOptions, "paymentId" | "orderId" | "amountMinor" | "currency" | "method">> & Partial<FixtureOptions>): Record<string, unknown> {
  return {
    id: o.paymentId,
    entity: "payment",
    order_id: o.orderId,
    amount: o.amountMinor,
    currency: o.currency,
    status,
    method: o.method,
    error_code: o.failureCode ?? null,
    error_description: o.failureReason ?? null,
    ...(status === "captured" ? { captured: true } : {}),
  };
}

function orderEntity(status: string, o: Required<Pick<FixtureOptions, "orderId" | "amountMinor" | "currency">>): Record<string, unknown> {
  return {
    id: o.orderId,
    entity: "order",
    amount: o.amountMinor,
    amount_paid: status === "paid" ? o.amountMinor : 0,
    amount_due: status === "paid" ? 0 : o.amountMinor,
    currency: o.currency,
    status,
  };
}

/** Build a signed webhook fixture for the given event. */
export function buildWebhookFixture(
  eventType: SupportedEvent | string,
  secret: string,
  options: FixtureOptions = {},
): WebhookFixture {
  const accountId = options.accountId ?? "acc_test_RECOVEROS1";
  const paymentId = options.paymentId ?? "pay_seedTest0001";
  const orderId = options.orderId ?? "order_seedTest0001";
  const amountMinor = options.amountMinor ?? 500_000;
  const currency = options.currency ?? "INR";
  const method = options.method ?? "card";
  const createdAt = options.createdAt ?? 1_756_000_000;
  const base = { paymentId, orderId, amountMinor, currency, method, failureCode: options.failureCode, failureReason: options.failureReason };

  const payload: Record<string, unknown> = {};
  let contains: string[] = ["payment"];

  switch (eventType) {
    case "payment.authorized":
      payload.payment = { entity: paymentEntity("authorized", base) };
      break;
    case "payment.captured":
      payload.payment = { entity: paymentEntity("captured", base) };
      break;
    case "payment.failed":
      payload.payment = {
        entity: paymentEntity("failed", { ...base, failureCode: options.failureCode ?? "BAD_REQUEST_ERROR", failureReason: options.failureReason ?? "payment failed" }),
      };
      break;
    case "payment.refunded":
      payload.payment = { entity: { ...paymentEntity("refunded", base), amount_refunded: amountMinor } };
      break;
    case "payment.partially_refunded":
      payload.payment = { entity: { ...paymentEntity("captured", base), amount_refunded: Math.floor(amountMinor / 2) } };
      break;
    case "order.paid":
      payload.payment = { entity: paymentEntity("captured", base) };
      payload.order = { entity: orderEntity("paid", { orderId, amountMinor, currency }) };
      contains = ["payment", "order"];
      break;
    default:
      // Unknown/other event — still a valid envelope with a payment entity.
      payload.payment = { entity: paymentEntity("created", base) };
  }

  const body: Record<string, unknown> = {
    entity: "event",
    account_id: accountId,
    event: eventType,
    contains,
    created_at: createdAt,
    payload,
  };

  const rawBody = JSON.stringify(body);
  const eventId = options.eventId ?? `evt_${paymentId}_${eventType}`;
  return { rawBody, signature: computeSignature(rawBody, secret), eventId, accountId, body };
}
