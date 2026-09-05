/**
 * Persistence port for the webhook pipeline. Tenant-scoped: every method takes
 * an explicit tenantId (resolved by the processor from the verified provider
 * account — never from the client). The processor depends only on this port, so
 * it is testable without a database; a Prisma adapter provides production.
 *
 * The store NEVER receives or persists secrets (API/webhook secrets). Payloads
 * are stored with an explicit test-mode/provider marker.
 */
import type { CanonicalStatus, InternalEventType } from "./reconcile";

export type WebhookStatus =
  | "RECEIVED"
  | "VERIFIED"
  | "PROCESSED"
  | "INVALID_SIGNATURE"
  | "DUPLICATE"
  | "FAILED";

export interface WebhookRecord {
  id: string;
  tenantId: string;
  providerEventId: string;
  eventType: string;
  signatureValid: boolean;
  status: WebhookStatus;
  receivedAt: Date;
  processedAt: Date | null;
  error: string | null;
}

export interface CreateWebhookInput {
  tenantId: string;
  providerEventId: string;
  eventType: string;
  signatureValid: boolean;
  status: WebhookStatus;
  /** Original provider payload (object) — stored with a synthetic/test marker. */
  payload: Record<string, unknown>;
  receivedAt: Date;
}

export interface WebhookPatch {
  status?: WebhookStatus;
  processedAt?: Date | null;
  error?: string | null;
}

export interface PaymentRecord {
  id: string;
  tenantId: string;
  razorpayPaymentId: string;
  razorpayOrderId: string | null;
  status: CanonicalStatus;
  method: string | null;
  amountMinor: number;
  currency: string;
  failureCode: string | null;
  failureReason: string | null;
  capturedAt: Date | null;
}

export interface UpsertPaymentInput {
  tenantId: string;
  razorpayPaymentId: string;
  razorpayOrderId: string | null;
  status: CanonicalStatus;
  method: string | null;
  amountMinor: number;
  currency: string;
  failureCode: string | null;
  failureReason: string | null;
  capturedAt: Date | null;
}

export interface CreatePaymentEventInput {
  tenantId: string;
  paymentId: string | null;
  type: InternalEventType;
  rawType: string;
  sourceWebhookEventId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface WebhookAuditEntry {
  tenantId: string | null;
  actorType: "SYSTEM";
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface WebhookStore {
  findWebhookByEventId(tenantId: string, providerEventId: string): Promise<WebhookRecord | null>;
  createWebhook(input: CreateWebhookInput): Promise<WebhookRecord>;
  updateWebhook(id: string, patch: WebhookPatch): Promise<WebhookRecord>;
  findPaymentByRef(tenantId: string, razorpayPaymentId: string): Promise<PaymentRecord | null>;
  upsertPayment(input: UpsertPaymentInput): Promise<PaymentRecord>;
  /** Idempotency for events: at most one per (webhook, type). */
  paymentEventExists(tenantId: string, sourceWebhookEventId: string, type: InternalEventType): Promise<boolean>;
  createPaymentEvent(input: CreatePaymentEventInput): Promise<void>;
  appendAudit(entry: WebhookAuditEntry): Promise<void>;
}

/**
 * Hook that lets the payment-intelligence layer update/create a RecoveryCase
 * from reconciled facts. The webhook NEVER executes recovery; it only updates
 * facts and lets this reconciler (deterministic detection) decide case state.
 */
export interface CaseReconciler {
  onPaymentReconciled(input: {
    tenantId: string;
    payment: PaymentRecord;
    previousStatus: CanonicalStatus | null;
    eventType: string;
  }): Promise<void>;
}
