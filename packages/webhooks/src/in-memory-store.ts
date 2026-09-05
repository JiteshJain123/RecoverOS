/**
 * In-memory WebhookStore + a spy CaseReconciler for tests and local replay.
 * Mirrors the Prisma adapter's tenant scoping and idempotency guarantees.
 */
import type {
  CaseReconciler,
  CreatePaymentEventInput,
  CreateWebhookInput,
  PaymentRecord,
  UpsertPaymentInput,
  WebhookAuditEntry,
  WebhookPatch,
  WebhookRecord,
  WebhookStore,
} from "./store";
import type { CanonicalStatus, InternalEventType } from "./reconcile";

export type RecordedPaymentEvent = CreatePaymentEventInput;
export type RecordedWebhookAudit = WebhookAuditEntry;

export class InMemoryWebhookStore implements WebhookStore {
  readonly webhooks: WebhookRecord[] = [];
  readonly payments: PaymentRecord[] = [];
  readonly paymentEvents: RecordedPaymentEvent[] = [];
  readonly audits: RecordedWebhookAudit[] = [];
  private seq = 0;

  constructor(seed: { payments?: PaymentRecord[] } = {}) {
    for (const p of seed.payments ?? []) this.payments.push({ ...p });
  }

  async findWebhookByEventId(tenantId: string, providerEventId: string): Promise<WebhookRecord | null> {
    return this.webhooks.find((w) => w.tenantId === tenantId && w.providerEventId === providerEventId) ?? null;
  }

  async createWebhook(input: CreateWebhookInput): Promise<WebhookRecord> {
    this.seq += 1;
    const rec: WebhookRecord = {
      id: `wh_${this.seq}`,
      tenantId: input.tenantId,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      signatureValid: input.signatureValid,
      status: input.status,
      receivedAt: input.receivedAt,
      processedAt: null,
      error: null,
    };
    this.webhooks.push(rec);
    return { ...rec };
  }

  async updateWebhook(id: string, patch: WebhookPatch): Promise<WebhookRecord> {
    const rec = this.webhooks.find((w) => w.id === id);
    if (!rec) throw new Error(`Webhook ${id} not found.`);
    if (patch.status !== undefined) rec.status = patch.status;
    if (patch.processedAt !== undefined) rec.processedAt = patch.processedAt;
    if (patch.error !== undefined) rec.error = patch.error;
    return { ...rec };
  }

  async findPaymentByRef(tenantId: string, razorpayPaymentId: string): Promise<PaymentRecord | null> {
    return this.payments.find((p) => p.tenantId === tenantId && p.razorpayPaymentId === razorpayPaymentId) ?? null;
  }

  async upsertPayment(input: UpsertPaymentInput): Promise<PaymentRecord> {
    const existing = this.payments.find(
      (p) => p.tenantId === input.tenantId && p.razorpayPaymentId === input.razorpayPaymentId,
    );
    if (existing) {
      existing.status = input.status;
      existing.razorpayOrderId = input.razorpayOrderId ?? existing.razorpayOrderId;
      existing.method = input.method ?? existing.method;
      existing.amountMinor = input.amountMinor || existing.amountMinor;
      existing.currency = input.currency || existing.currency;
      existing.failureCode = input.failureCode ?? existing.failureCode;
      existing.failureReason = input.failureReason ?? existing.failureReason;
      existing.capturedAt = input.capturedAt ?? existing.capturedAt;
      return { ...existing };
    }
    this.seq += 1;
    const rec: PaymentRecord = { id: `pay_${this.seq}`, ...input };
    this.payments.push(rec);
    return { ...rec };
  }

  async paymentEventExists(
    tenantId: string,
    sourceWebhookEventId: string,
    type: InternalEventType,
  ): Promise<boolean> {
    return this.paymentEvents.some(
      (e) => e.tenantId === tenantId && e.sourceWebhookEventId === sourceWebhookEventId && e.type === type,
    );
  }

  async createPaymentEvent(input: CreatePaymentEventInput): Promise<void> {
    this.paymentEvents.push({ ...input });
  }

  async appendAudit(entry: WebhookAuditEntry): Promise<void> {
    this.audits.push({ ...entry });
  }
}

/** Records reconciliation calls; never creates cases (test double). */
export class SpyCaseReconciler implements CaseReconciler {
  readonly calls: Array<{ tenantId: string; paymentId: string; previousStatus: CanonicalStatus | null; eventType: string }> = [];
  async onPaymentReconciled(input: {
    tenantId: string;
    payment: PaymentRecord;
    previousStatus: CanonicalStatus | null;
    eventType: string;
  }): Promise<void> {
    this.calls.push({
      tenantId: input.tenantId,
      paymentId: input.payment.id,
      previousStatus: input.previousStatus,
      eventType: input.eventType,
    });
  }
}
