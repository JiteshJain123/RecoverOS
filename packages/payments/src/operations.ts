/**
 * Provider-neutral payment-gateway operations RecoverOS needs. These are the
 * ONLY gateway capabilities exposed — there is no raw Razorpay passthrough. All
 * results are provider-neutral (amounts in minor units) and carry NO secrets.
 *
 * Every operation requires a tenant context and resolves that tenant's
 * credentials through the secure configuration boundary.
 */
import type { PaymentsTenantContext } from "./config";

export interface PaymentView {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  orderId: string | null;
  method: string | null;
  captured: boolean;
}

export interface OrderView {
  id: string;
  amountMinor: number;
  amountPaidMinor: number | null;
  currency: string;
  status: string;
}

export interface PaymentLinkView {
  id: string;
  shortUrl: string;
  status: string;
  amountMinor: number;
  currency: string;
}

export interface CaptureResult {
  id: string;
  status: string;
  captured: boolean;
  amountMinor: number;
}

export interface CancelLinkResult {
  id: string;
  status: string;
}

export interface CreatePaymentLinkInput {
  amountMinor: number;
  currency: string;
  /** Idempotency/dedupe handle (also sent as the Razorpay reference_id). */
  referenceId: string;
  description?: string;
  /** Optional minimal customer contact (no PII is required). */
  customer?: { name?: string; email?: string; contact?: string };
}

/** Safe connection info returned by the dev verify endpoint. NEVER credentials. */
export interface ConnectionInfo {
  mode: "test";
  ok: boolean;
  latencyMs: number;
  requestId?: string;
}

/** The bounded set of gateway operations. */
export interface PaymentGatewayOperations {
  fetchPayment(ctx: PaymentsTenantContext, paymentId: string): Promise<PaymentView>;
  fetchOrder(ctx: PaymentsTenantContext, orderId: string): Promise<OrderView>;
  createPaymentLink(ctx: PaymentsTenantContext, input: CreatePaymentLinkInput): Promise<PaymentLinkView>;
  fetchPaymentLink(ctx: PaymentsTenantContext, linkId: string): Promise<PaymentLinkView>;
  cancelPaymentLink(ctx: PaymentsTenantContext, linkId: string): Promise<CancelLinkResult>;
  capturePayment(
    ctx: PaymentsTenantContext,
    paymentId: string,
    input: { amountMinor: number; currency: string; idempotencyKey?: string },
  ): Promise<CaptureResult>;
  verifyConnection(ctx: PaymentsTenantContext): Promise<ConnectionInfo>;
}
