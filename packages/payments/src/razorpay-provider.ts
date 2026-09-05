/**
 * RazorpayTestProvider — the real Razorpay TEST MODE adapter.
 *
 * It implements BOTH the execution-layer `PaymentRecoveryProvider` (so it drops
 * into the existing executor in place of the simulator) AND the provider-neutral
 * `PaymentGatewayOperations` (fetch payment/order, payment links, capture).
 *
 * SAFETY BOUNDARIES PRESERVED:
 *  - It is invoked ONLY by the RecoveryActionExecutor, i.e. AFTER policy ALLOW
 *    (or human-approved REVIEW) and all execution safeguards. It is never
 *    imported by @recoveros/ai, so Gemini can never call it directly.
 *  - It never moves real money: TEST MODE credentials only (enforced in config).
 *  - It never exposes secrets: only provider-neutral, redacted data leaves it.
 *  - `execute` catches gateway errors and returns a terminal RecoveryProvider
 *    result (so the action state machine stays consistent); the direct
 *    operations throw typed errors for callers that need them.
 */
import type { Logger } from "@recoveros/observability";
import type {
  PaymentRecoveryProvider,
  RecoveryProviderRequest,
  RecoveryProviderResult,
} from "@recoveros/execution";
import { RazorpayError } from "./errors";
import type { PaymentsTenantContext } from "./config";
import type { RazorpayClient } from "./client";
import {
  razorpayOrderSchema,
  razorpayPaymentLinkSchema,
  razorpayPaymentSchema,
} from "./schemas";
import { RazorpayMalformedResponseError } from "./errors";
import type {
  CancelLinkResult,
  CaptureResult,
  ConnectionInfo,
  CreatePaymentLinkInput,
  OrderView,
  PaymentGatewayOperations,
  PaymentLinkView,
  PaymentView,
} from "./operations";

export interface RazorpayTestProviderDeps {
  client: RazorpayClient;
  logger?: Logger;
}

function requireTenant(req: RecoveryProviderRequest): PaymentsTenantContext {
  const tenantId = typeof req.metadata.tenantId === "string" ? req.metadata.tenantId.trim() : "";
  if (!tenantId) {
    // Internal invariant: the executor always injects the tenant context.
    throw new Error("Razorpay provider requires a tenant context in request metadata.");
  }
  return { tenantId };
}

export class RazorpayTestProvider implements PaymentRecoveryProvider, PaymentGatewayOperations {
  readonly name = "razorpay-test";
  private readonly client: RazorpayClient;
  private readonly logger?: Logger;

  constructor(deps: RazorpayTestProviderDeps) {
    this.client = deps.client;
    this.logger = deps.logger;
  }

  // --- Execution-layer surface (PaymentRecoveryProvider) -------------------

  /**
   * Perform an authorized recovery action. Reached ONLY after policy ALLOW /
   * approval + safeguards. Gateway errors become a terminal FAILED/TIMEOUT
   * result so the action lifecycle stays consistent; no secret ever leaks.
   */
  async execute(req: RecoveryProviderRequest): Promise<RecoveryProviderResult> {
    const ctx = requireTenant(req);
    try {
      if (req.actionType === "SEND_PAYMENT_LINK") {
        const link = await this.createPaymentLink(ctx, {
          amountMinor: req.amountMinor ?? 0,
          currency: req.currency,
          referenceId: req.idempotencyKey,
        });
        return {
          outcome: "LINK_CREATED",
          externalReference: link.id,
          recoveredAmountMinor: 0,
          detail: `payment_link ${link.status}`,
        };
      }

      if (req.actionType === "RETRY_PAYMENT") {
        // "Retry" recovers by CAPTURING an authorized payment. It is NEVER a
        // blind re-charge: we require the payment reference and only capture when
        // the payment is actually in a capturable ("authorized") state. If it is
        // not, we return a classified capability error and NEVER fake success.
        const paymentRef = typeof req.metadata.paymentRef === "string" ? req.metadata.paymentRef : "";
        if (!paymentRef) {
          return { outcome: "FAILED", externalReference: "", recoveredAmountMinor: 0, detail: "capability:no_payment_reference" };
        }
        const current = await this.fetchPayment(ctx, paymentRef);
        if (current.status !== "authorized") {
          // Capture is not valid for this state (e.g. failed/created/captured).
          return {
            outcome: "FAILED",
            externalReference: current.id,
            recoveredAmountMinor: 0,
            detail: `capability:not_capturable:${current.status}`,
          };
        }
        const cap = await this.capturePayment(ctx, paymentRef, {
          amountMinor: req.amountMinor ?? current.amountMinor,
          currency: req.currency,
          idempotencyKey: req.idempotencyKey,
        });
        const recovered = cap.captured && cap.status === "captured";
        return {
          outcome: recovered ? "SUCCEEDED" : "FAILED",
          externalReference: cap.id,
          recoveredAmountMinor: recovered ? cap.amountMinor : 0,
          detail: `capture ${cap.status}`,
        };
      }

      // CONTACT_CUSTOMER is not a gateway/money operation — not supported here.
      return { outcome: "FAILED", externalReference: "", recoveredAmountMinor: 0, detail: "action_not_supported_by_gateway" };
    } catch (err) {
      if (err instanceof RazorpayError) {
        const outcome = err.category === "timeout" ? "TIMEOUT" : "FAILED";
        this.logger?.warn("razorpay.execute.failed", {
          tenantId: ctx.tenantId,
          actionType: req.actionType,
          category: err.category,
          status: err.status,
        });
        return { outcome, externalReference: "", recoveredAmountMinor: 0, detail: `razorpay_${err.category}` };
      }
      throw err;
    }
  }

  // --- Provider-neutral operations (PaymentGatewayOperations) --------------

  async fetchPayment(ctx: PaymentsTenantContext, paymentId: string): Promise<PaymentView> {
    const { data } = await this.client.request(ctx, {
      operation: "fetch_payment",
      method: "GET",
      path: `/payments/${encodeURIComponent(paymentId)}`,
    });
    const p = parse(razorpayPaymentSchema, data);
    return {
      id: p.id,
      amountMinor: p.amount,
      currency: p.currency,
      status: p.status,
      orderId: p.order_id ?? null,
      method: p.method ?? null,
      captured: p.captured ?? p.status === "captured",
    };
  }

  async fetchOrder(ctx: PaymentsTenantContext, orderId: string): Promise<OrderView> {
    const { data } = await this.client.request(ctx, {
      operation: "fetch_order",
      method: "GET",
      path: `/orders/${encodeURIComponent(orderId)}`,
    });
    const o = parse(razorpayOrderSchema, data);
    return {
      id: o.id,
      amountMinor: o.amount,
      amountPaidMinor: o.amount_paid ?? null,
      currency: o.currency,
      status: o.status,
    };
  }

  async createPaymentLink(ctx: PaymentsTenantContext, input: CreatePaymentLinkInput): Promise<PaymentLinkView> {
    const body: Record<string, unknown> = {
      amount: input.amountMinor,
      currency: input.currency,
      reference_id: input.referenceId,
      description: input.description ?? "RecoverOS recovery payment link (test mode)",
    };
    if (input.customer) body.customer = input.customer;
    const { data } = await this.client.request(ctx, {
      operation: "create_payment_link",
      method: "POST",
      path: "/payment_links",
      body,
      idempotencyKey: input.referenceId,
    });
    return toLinkView(parse(razorpayPaymentLinkSchema, data));
  }

  async fetchPaymentLink(ctx: PaymentsTenantContext, linkId: string): Promise<PaymentLinkView> {
    const { data } = await this.client.request(ctx, {
      operation: "fetch_payment_link",
      method: "GET",
      path: `/payment_links/${encodeURIComponent(linkId)}`,
    });
    return toLinkView(parse(razorpayPaymentLinkSchema, data));
  }

  async cancelPaymentLink(ctx: PaymentsTenantContext, linkId: string): Promise<CancelLinkResult> {
    const { data } = await this.client.request(ctx, {
      operation: "cancel_payment_link",
      method: "POST",
      path: `/payment_links/${encodeURIComponent(linkId)}/cancel`,
    });
    const l = parse(razorpayPaymentLinkSchema, data);
    return { id: l.id, status: l.status };
  }

  async capturePayment(
    ctx: PaymentsTenantContext,
    paymentId: string,
    input: { amountMinor: number; currency: string; idempotencyKey?: string },
  ): Promise<CaptureResult> {
    const { data } = await this.client.request(ctx, {
      operation: "capture_payment",
      method: "POST",
      path: `/payments/${encodeURIComponent(paymentId)}/capture`,
      body: { amount: input.amountMinor, currency: input.currency },
      idempotencyKey: input.idempotencyKey,
    });
    const p = parse(razorpayPaymentSchema, data);
    return {
      id: p.id,
      status: p.status,
      captured: p.captured ?? p.status === "captured",
      amountMinor: p.amount,
    };
  }

  /** Harmless authenticated read used by the dev verify endpoint. */
  async verifyConnection(ctx: PaymentsTenantContext): Promise<ConnectionInfo> {
    const { meta } = await this.client.request(ctx, {
      operation: "verify_connection",
      method: "GET",
      path: "/payments",
      query: { count: 1 },
    });
    return { mode: "test", ok: meta.status >= 200 && meta.status < 300, latencyMs: meta.latencyMs, requestId: meta.requestId };
  }
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new RazorpayMalformedResponseError();
  return r.data;
}

function toLinkView(l: { id: string; short_url: string; status: string; amount: number; currency: string }): PaymentLinkView {
  return { id: l.id, shortUrl: l.short_url, status: l.status, amountMinor: l.amount, currency: l.currency };
}
