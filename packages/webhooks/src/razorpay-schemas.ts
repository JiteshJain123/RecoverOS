/**
 * Typed adapter boundary for the SUBSET of Razorpay webhook payloads we consume.
 *
 * Razorpay webhooks are not all the same shape: the envelope is stable but the
 * `payload` bag varies per event (payment / order / refund entities). We
 * validate the envelope + the entities we actually read, and normalize into a
 * provider-neutral {@link ParsedWebhookEvent}. Extra provider fields are
 * tolerated (`.passthrough()`) but never consumed. A malformed body raises a
 * typed {@link WebhookPayloadError} — we never guess a shape.
 */
import { z } from "zod";
import { WebhookPayloadError } from "./errors";

const amountMinor = z.number().int().nonnegative();

const paymentEntitySchema = z
  .object({
    id: z.string(),
    order_id: z.string().nullable().optional(),
    amount: amountMinor,
    currency: z.string(),
    status: z.string(),
    method: z.string().nullable().optional(),
    error_code: z.string().nullable().optional(),
    error_description: z.string().nullable().optional(),
    amount_refunded: amountMinor.optional(),
    captured: z.boolean().optional(),
  })
  .passthrough();

const orderEntitySchema = z
  .object({
    id: z.string(),
    amount: amountMinor,
    amount_paid: amountMinor.optional(),
    amount_due: amountMinor.optional(),
    currency: z.string(),
    status: z.string(),
    receipt: z.string().nullable().optional(),
  })
  .passthrough();

const envelopeSchema = z
  .object({
    entity: z.literal("event"),
    account_id: z.string(),
    event: z.string(),
    contains: z.array(z.string()).optional(),
    created_at: z.number(),
    payload: z
      .object({
        payment: z.object({ entity: paymentEntitySchema }).optional(),
        order: z.object({ entity: orderEntitySchema }).optional(),
        refund: z.object({ entity: z.record(z.unknown()) }).optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** The Razorpay webhook events RecoverOS acts on. */
export const SUPPORTED_EVENTS = [
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "payment.refunded",
  "payment.partially_refunded",
  "order.paid",
] as const;
export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

export function isSupportedEvent(event: string): event is SupportedEvent {
  return (SUPPORTED_EVENTS as readonly string[]).includes(event);
}

/** Provider-neutral payment entity. Amounts are integer minor units. */
export interface NeutralPayment {
  id: string;
  orderId: string | null;
  amountMinor: number;
  currency: string;
  status: string;
  method: string | null;
  failureCode: string | null;
  failureReason: string | null;
  amountRefundedMinor: number | null;
}

export interface NeutralOrder {
  id: string;
  amountMinor: number;
  amountPaidMinor: number | null;
  currency: string;
  status: string;
}

export interface ParsedWebhookEvent {
  eventType: string;
  supported: boolean;
  accountId: string;
  createdAt: number;
  contains: string[];
  payment: NeutralPayment | null;
  order: NeutralOrder | null;
}

/**
 * Parse an already-JSON-decoded webhook body into a neutral event. Throws
 * {@link WebhookPayloadError} if the envelope does not validate.
 */
export function parseWebhookEvent(json: unknown): ParsedWebhookEvent {
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) throw new WebhookPayloadError();
  const e = parsed.data;

  const p = e.payload.payment?.entity;
  const o = e.payload.order?.entity;

  return {
    eventType: e.event,
    supported: isSupportedEvent(e.event),
    accountId: e.account_id,
    createdAt: e.created_at,
    contains: e.contains ?? [],
    payment: p
      ? {
          id: p.id,
          orderId: p.order_id ?? null,
          amountMinor: p.amount,
          currency: p.currency,
          status: p.status,
          method: p.method ?? null,
          failureCode: p.error_code ?? null,
          failureReason: p.error_description ?? null,
          amountRefundedMinor: p.amount_refunded ?? null,
        }
      : null,
    order: o
      ? { id: o.id, amountMinor: o.amount, amountPaidMinor: o.amount_paid ?? null, currency: o.currency, status: o.status }
      : null,
  };
}
