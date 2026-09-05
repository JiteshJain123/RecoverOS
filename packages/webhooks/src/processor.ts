/**
 * WebhookProcessor — the financial-integrity ingestion pipeline:
 *
 *   raw body → signature verify → event-id idempotency → payload validation
 *     → tenant/provider mapping → canonical PaymentEvent → payment reconciliation
 *     → (case reconciliation) → audit trail
 *
 * It updates FACTS only. It never executes recovery, never sends messages, never
 * calls the Razorpay API — the recovery engine decides what happens next. All
 * writes are tenant-scoped to the tenant resolved from the VERIFIED provider
 * account; a client-supplied tenant is never trusted.
 */
import type { Logger } from "@recoveros/observability";
import { verifyRazorpaySignature } from "./signature";
import { parseWebhookEvent, type ParsedWebhookEvent } from "./razorpay-schemas";
import { WebhookPayloadError } from "./errors";
import { advances, mapEvent, type CanonicalStatus } from "./reconcile";
import type { ProviderAccountResolver, WebhookSecretSource } from "./tenant-map";
import type { CaseReconciler, WebhookRecord, WebhookStore } from "./store";

export interface Clock {
  now(): Date;
}

export interface WebhookInput {
  rawBody: Buffer | string;
  signature?: string | null;
  /** Razorpay `X-Razorpay-Event-Id` header — the idempotency key. */
  eventId?: string | null;
}

export type WebhookResultStatus = "processed" | "duplicate" | "rejected" | "failed";

export interface WebhookResult {
  status: WebhookResultStatus;
  httpStatus: number;
  code?: string;
  tenantId?: string;
  webhookId?: string;
  reason?: string;
}

export interface WebhookProcessorDeps {
  store: WebhookStore;
  resolver: ProviderAccountResolver;
  secret: WebhookSecretSource;
  clock: Clock;
  caseReconciler?: CaseReconciler;
  logger?: Logger;
}

export class WebhookProcessor {
  private readonly store: WebhookStore;
  private readonly resolver: ProviderAccountResolver;
  private readonly secret: WebhookSecretSource;
  private readonly clock: Clock;
  private readonly caseReconciler?: CaseReconciler;
  private readonly logger?: Logger;

  constructor(deps: WebhookProcessorDeps) {
    this.store = deps.store;
    this.resolver = deps.resolver;
    this.secret = deps.secret;
    this.clock = deps.clock;
    this.caseReconciler = deps.caseReconciler;
    this.logger = deps.logger;
  }

  private audit(
    tenantId: string | null,
    action: string,
    entityId: string,
    summary: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    return this.store.appendAudit({
      tenantId,
      actorType: "SYSTEM",
      action,
      entityType: "WebhookEvent",
      entityId,
      summary,
      metadata,
    });
  }

  async process(input: WebhookInput): Promise<WebhookResult> {
    const receivedAt = this.clock.now();
    const eventIdHeader = input.eventId?.trim() || "unknown";
    await this.audit(null, "webhook.received", eventIdHeader, "Webhook received.", {
      provider: "RAZORPAY",
      hasSignature: Boolean(input.signature),
    });

    // 1) Signature verification over the RAW body.
    const secret = this.secret.getSecret();
    if (!secret) {
      await this.audit(null, "webhook.rejected", eventIdHeader, "Webhook secret not configured.", { reason: "not_configured" });
      return { status: "rejected", httpStatus: 503, code: "not_configured" };
    }
    if (!verifyRazorpaySignature(input.rawBody, input.signature, secret)) {
      // Not trusted → do NOT persist a trusted event and do NOT trigger recovery.
      await this.audit(null, "webhook.rejected", eventIdHeader, "Invalid webhook signature.", { reason: "invalid_signature" });
      return { status: "rejected", httpStatus: 401, code: "invalid_signature" };
    }
    await this.audit(null, "webhook.signature_verified", eventIdHeader, "Signature verified.", {});

    // 2) Payload validation (post-verification parse is safe).
    let event: ParsedWebhookEvent;
    try {
      const json: unknown = JSON.parse(bodyToString(input.rawBody));
      event = parseWebhookEvent(json);
    } catch (err) {
      const code = err instanceof WebhookPayloadError ? "invalid_payload" : "invalid_json";
      await this.audit(null, "webhook.processing_failed", eventIdHeader, "Payload validation failed.", { reason: code });
      return { status: "rejected", httpStatus: 400, code };
    }

    // 3) Tenant mapping from the VERIFIED provider account — never the client.
    const tenantId = this.resolver.resolveTenant(event.accountId);
    if (!tenantId) {
      await this.audit(null, "webhook.rejected", eventIdHeader, "Unmapped provider account.", {
        reason: "unmapped_account",
        // account id is provider-public, not a secret
        accountId: event.accountId,
      });
      return { status: "rejected", httpStatus: 400, code: "unmapped_account" };
    }

    // 4) Idempotency key from the event id header (fallback: deterministic).
    const providerEventId =
      input.eventId?.trim() ||
      `evt_${event.eventType}_${event.createdAt}_${event.payment?.id ?? event.order?.id ?? "na"}`;

    // 5) Idempotency check.
    const existing = await this.store.findWebhookByEventId(tenantId, providerEventId);
    let webhook: WebhookRecord;
    if (existing) {
      if (existing.status === "PROCESSED") {
        await this.audit(tenantId, "webhook.duplicate", existing.id, "Duplicate webhook (already processed).", {
          providerEventId,
        });
        return { status: "duplicate", httpStatus: 200, code: "duplicate", tenantId, webhookId: existing.id };
      }
      // A prior partial/failed attempt → safe retry, reusing the same row.
      webhook = await this.store.updateWebhook(existing.id, { status: "VERIFIED", error: null });
    } else {
      webhook = await this.store.createWebhook({
        tenantId,
        providerEventId,
        eventType: event.eventType,
        signatureValid: true,
        status: "VERIFIED",
        payload: markProviderData(bodyToString(input.rawBody)),
        receivedAt,
      });
    }

    // 6) Unsupported events: acknowledge, change no canonical state.
    if (!event.supported) {
      await this.store.updateWebhook(webhook.id, { status: "PROCESSED", processedAt: this.clock.now() });
      await this.audit(tenantId, "webhook.processed", webhook.id, `Acknowledged unsupported event ${event.eventType}.`, {
        eventType: event.eventType,
        unsupported: true,
      });
      return { status: "processed", httpStatus: 200, code: "unsupported_event", tenantId, webhookId: webhook.id };
    }

    // 7) Process: normalize + reconcile. Failures preserve idempotency + allow retry.
    try {
      await this.applyEvent(tenantId, event, webhook);
      await this.store.updateWebhook(webhook.id, { status: "PROCESSED", processedAt: this.clock.now(), error: null });
      await this.audit(tenantId, "webhook.processed", webhook.id, `Processed ${event.eventType}.`, {
        eventType: event.eventType,
      });
      return { status: "processed", httpStatus: 200, tenantId, webhookId: webhook.id };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "processing_error";
      await this.store.updateWebhook(webhook.id, { status: "FAILED", error: reason.slice(0, 300) });
      await this.audit(tenantId, "webhook.processing_failed", webhook.id, "Processing failed after a valid event.", {
        eventType: event.eventType,
        reason: reason.slice(0, 300),
      });
      this.logger?.warn("webhook.processing_failed", { tenantId, webhookId: webhook.id, eventType: event.eventType });
      // 5xx so the provider re-delivers; the retry is idempotent (same row).
      return { status: "failed", httpStatus: 500, code: "processing_failed", tenantId, webhookId: webhook.id };
    }
  }

  /** Normalize the event into a PaymentEvent and reconcile canonical state. */
  private async applyEvent(tenantId: string, event: ParsedWebhookEvent, webhook: WebhookRecord): Promise<void> {
    const mapping = mapEvent(event.eventType);
    const occurredAt = new Date(event.createdAt * 1000);
    const p = event.payment;

    // Order-only event (no payment entity): record the fact, no payment change.
    if (!p) {
      if (!(await this.store.paymentEventExists(tenantId, webhook.id, mapping.internalType))) {
        await this.store.createPaymentEvent({
          tenantId,
          paymentId: null,
          type: mapping.internalType,
          rawType: event.eventType,
          sourceWebhookEventId: webhook.id,
          payload: { order: event.order },
          occurredAt,
        });
      }
      return;
    }

    const existing = await this.store.findPaymentByRef(tenantId, p.id);
    const previousStatus: CanonicalStatus | null = existing?.status ?? null;
    const asserted = mapping.status ?? previousStatus ?? "CREATED";
    // Out-of-order safe: never downgrade; keep the most-advanced status.
    const newStatus: CanonicalStatus = advances(previousStatus, asserted) ? asserted : (previousStatus as CanonicalStatus);
    const capturedAt =
      newStatus === "CAPTURED" && previousStatus !== "CAPTURED" ? occurredAt : existing?.capturedAt ?? null;

    const payment = await this.store.upsertPayment({
      tenantId,
      razorpayPaymentId: p.id,
      razorpayOrderId: p.orderId ?? existing?.razorpayOrderId ?? null,
      status: newStatus,
      method: p.method ?? existing?.method ?? null,
      amountMinor: p.amountMinor,
      currency: p.currency,
      failureCode: p.failureCode ?? existing?.failureCode ?? null,
      failureReason: p.failureReason ?? existing?.failureReason ?? null,
      capturedAt,
    });

    // Idempotent PaymentEvent (at most one per (webhook, type)).
    if (!(await this.store.paymentEventExists(tenantId, webhook.id, mapping.internalType))) {
      await this.store.createPaymentEvent({
        tenantId,
        paymentId: payment.id,
        type: mapping.internalType,
        rawType: event.eventType,
        sourceWebhookEventId: webhook.id,
        payload: { payment: p },
        occurredAt,
      });
    }

    if (newStatus !== previousStatus) {
      await this.audit(tenantId, "payment.state_changed", payment.id, `Payment ${previousStatus ?? "NEW"} → ${newStatus}.`, {
        from: previousStatus,
        to: newStatus,
        razorpayPaymentId: p.id,
        eventType: event.eventType,
      });
    }

    // Facts → case reconciliation (deterministic detection); NEVER executes recovery.
    if (this.caseReconciler) {
      await this.caseReconciler.onPaymentReconciled({ tenantId, payment, previousStatus, eventType: event.eventType });
    }
  }
}

function bodyToString(body: Buffer | string): string {
  return typeof body === "string" ? body : body.toString("utf8");
}

/** Wrap the stored payload with an explicit provider/test-mode marker. */
function markProviderData(rawJson: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    payload = { _unparsed: true };
  }
  return { provider: "RAZORPAY", testMode: true, storedAt: new Date().toISOString(), payload };
}
