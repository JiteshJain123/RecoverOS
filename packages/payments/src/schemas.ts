/**
 * Typed schemas for the SUBSET of Razorpay responses RecoverOS consumes. We
 * validate every response we depend on so a malformed/unexpected body becomes a
 * typed `RazorpayMalformedResponseError` rather than a silent shape mismatch.
 *
 * We deliberately do NOT model the entire Razorpay API — only the fields the
 * recovery flow uses. `.passthrough()` tolerates extra provider fields without
 * consuming them.
 */
import { z } from "zod";

/** Amounts from Razorpay are integers in the smallest currency unit (paise). */
const amountMinor = z.number().int().nonnegative();

export const razorpayPaymentSchema = z
  .object({
    id: z.string(),
    entity: z.literal("payment").optional(),
    amount: amountMinor,
    currency: z.string(),
    status: z.string(), // created | authorized | captured | refunded | failed
    order_id: z.string().nullable().optional(),
    method: z.string().nullable().optional(),
    captured: z.boolean().optional(),
    amount_refunded: amountMinor.optional(),
  })
  .passthrough();
export type RazorpayPaymentRaw = z.infer<typeof razorpayPaymentSchema>;

export const razorpayOrderSchema = z
  .object({
    id: z.string(),
    entity: z.literal("order").optional(),
    amount: amountMinor,
    amount_paid: amountMinor.optional(),
    amount_due: amountMinor.optional(),
    currency: z.string(),
    status: z.string(), // created | attempted | paid
    receipt: z.string().nullable().optional(),
  })
  .passthrough();
export type RazorpayOrderRaw = z.infer<typeof razorpayOrderSchema>;

export const razorpayPaymentLinkSchema = z
  .object({
    id: z.string(),
    status: z.string(), // created | partially_paid | paid | cancelled | expired
    amount: amountMinor,
    currency: z.string(),
    short_url: z.string(),
    reference_id: z.string().nullable().optional(),
  })
  .passthrough();
export type RazorpayPaymentLinkRaw = z.infer<typeof razorpayPaymentLinkSchema>;
