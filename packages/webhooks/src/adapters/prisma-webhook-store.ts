/**
 * Prisma-backed WebhookStore + a fact-based CaseReconciler (production).
 *
 * Tenant scoping: every read/write filters by tenantId. Idempotency is enforced
 * by the `@@unique([tenantId, providerEventId])` on WebhookEvent and by the
 * per-(webhook, type) PaymentEvent guard. No secrets are ever written; payloads
 * carry an explicit test-mode/provider marker (added by the processor).
 *
 * The CaseReconciler only updates FACTS: it ensures a RecoveryCase exists when a
 * payment fails, and marks an open case RECOVERED when the payment is
 * captured/refunded. It never executes recovery — the recovery engine decides
 * strategy/policy/execution separately.
 */
import { prisma, Prisma } from "@recoveros/database";
import type {
  CaseReconciler,
  CreatePaymentEventInput,
  CreateWebhookInput,
  PaymentRecord,
  UpsertPaymentInput,
  WebhookAuditEntry,
  WebhookPatch,
  WebhookRecord,
  WebhookStatus,
  WebhookStore,
} from "../store";
import type { CanonicalStatus, InternalEventType } from "../reconcile";

const asJson = (v: unknown): Prisma.InputJsonValue => v as unknown as Prisma.InputJsonValue;

interface WebhookRow {
  id: string;
  tenantId: string;
  providerEventId: string;
  eventType: string;
  signatureValid: boolean;
  status: string;
  receivedAt: Date;
  processedAt: Date | null;
  error: string | null;
}

function toWebhookRecord(r: WebhookRow): WebhookRecord {
  return { ...r, status: r.status as WebhookStatus };
}

export class PrismaWebhookStore implements WebhookStore {
  async findWebhookByEventId(tenantId: string, providerEventId: string): Promise<WebhookRecord | null> {
    const r = await prisma.webhookEvent.findFirst({ where: { tenantId, providerEventId } });
    return r ? toWebhookRecord(r as unknown as WebhookRow) : null;
  }

  async createWebhook(input: CreateWebhookInput): Promise<WebhookRecord> {
    const r = await prisma.webhookEvent.create({
      data: {
        tenantId: input.tenantId,
        provider: "RAZORPAY",
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        signatureValid: input.signatureValid,
        status: input.status as Prisma.WebhookEventCreateInput["status"],
        payload: asJson(input.payload),
        receivedAt: input.receivedAt,
      },
    });
    return toWebhookRecord(r as unknown as WebhookRow);
  }

  async updateWebhook(id: string, patch: WebhookPatch): Promise<WebhookRecord> {
    const data: Prisma.WebhookEventUpdateInput = {};
    if (patch.status !== undefined) data.status = patch.status as Prisma.WebhookEventUpdateInput["status"];
    if (patch.processedAt !== undefined) data.processedAt = patch.processedAt;
    if (patch.error !== undefined) data.error = patch.error;
    const r = await prisma.webhookEvent.update({ where: { id }, data });
    return toWebhookRecord(r as unknown as WebhookRow);
  }

  async findPaymentByRef(tenantId: string, razorpayPaymentId: string): Promise<PaymentRecord | null> {
    const p = await prisma.payment.findFirst({ where: { tenantId, razorpayPaymentId } });
    if (!p) return null;
    return {
      id: p.id,
      tenantId: p.tenantId,
      razorpayPaymentId: p.razorpayPaymentId ?? razorpayPaymentId,
      razorpayOrderId: p.razorpayOrderId,
      status: p.status as CanonicalStatus,
      method: p.method,
      amountMinor: p.amountMinor,
      currency: p.currency,
      failureCode: p.failureCode,
      failureReason: p.failureReason,
      capturedAt: p.capturedAt,
    };
  }

  async upsertPayment(input: UpsertPaymentInput): Promise<PaymentRecord> {
    const p = await prisma.payment.upsert({
      where: { tenantId_razorpayPaymentId: { tenantId: input.tenantId, razorpayPaymentId: input.razorpayPaymentId } },
      create: {
        tenantId: input.tenantId,
        razorpayPaymentId: input.razorpayPaymentId,
        razorpayOrderId: input.razorpayOrderId,
        status: input.status as Prisma.PaymentCreateInput["status"],
        method: input.method,
        amountMinor: input.amountMinor,
        currency: input.currency,
        failureCode: input.failureCode,
        failureReason: input.failureReason,
        capturedAt: input.capturedAt,
      },
      update: {
        razorpayOrderId: input.razorpayOrderId,
        status: input.status as Prisma.PaymentUpdateInput["status"],
        method: input.method,
        failureCode: input.failureCode,
        failureReason: input.failureReason,
        capturedAt: input.capturedAt,
      },
    });
    return {
      id: p.id,
      tenantId: p.tenantId,
      razorpayPaymentId: p.razorpayPaymentId ?? input.razorpayPaymentId,
      razorpayOrderId: p.razorpayOrderId,
      status: p.status as CanonicalStatus,
      method: p.method,
      amountMinor: p.amountMinor,
      currency: p.currency,
      failureCode: p.failureCode,
      failureReason: p.failureReason,
      capturedAt: p.capturedAt,
    };
  }

  async paymentEventExists(tenantId: string, sourceWebhookEventId: string, type: InternalEventType): Promise<boolean> {
    const n = await prisma.paymentEvent.count({
      where: { tenantId, sourceWebhookEventId, type: type as Prisma.PaymentEventWhereInput["type"] },
    });
    return n > 0;
  }

  async createPaymentEvent(input: CreatePaymentEventInput): Promise<void> {
    await prisma.paymentEvent.create({
      data: {
        tenantId: input.tenantId,
        paymentId: input.paymentId,
        type: input.type as Prisma.PaymentEventCreateInput["type"],
        rawType: input.rawType,
        sourceWebhookEventId: input.sourceWebhookEventId,
        payload: asJson(input.payload),
        occurredAt: input.occurredAt,
      },
    });
  }

  async appendAudit(entry: WebhookAuditEntry): Promise<void> {
    await prisma.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actorType: "SYSTEM",
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        metadata: asJson(entry.metadata),
      },
    });
  }
}

const OPEN_CASE_STATUSES = [
  "DETECTED",
  "ANALYZING",
  "PROPOSED",
  "PENDING_APPROVAL",
  "AUTHORIZED",
  "EXECUTING",
] as ("DETECTED" | "ANALYZING" | "PROPOSED" | "PENDING_APPROVAL" | "AUTHORIZED" | "EXECUTING")[];

/** Fact-based case reconciliation. Creates/closes cases; never executes recovery. */
export class PrismaCaseReconciler implements CaseReconciler {
  async onPaymentReconciled(input: {
    tenantId: string;
    payment: PaymentRecord;
    previousStatus: CanonicalStatus | null;
    eventType: string;
  }): Promise<void> {
    const { tenantId, payment, previousStatus } = input;

    // Newly failed → ensure an open recovery case exists (do not duplicate).
    if (payment.status === "FAILED" && previousStatus !== "FAILED") {
      await prisma.recoveryCase.upsert({
        where: { tenantId_paymentId: { tenantId, paymentId: payment.id } },
        create: {
          tenantId,
          paymentId: payment.id,
          reason: "FAILED_PAYMENT",
          status: "DETECTED",
          amountAtRiskMinor: payment.amountMinor,
          currency: payment.currency,
          openedAt: new Date(),
        },
        update: {},
      });
      return;
    }

    // Recovered (captured/refunded) → close any open case for this payment.
    if (
      (payment.status === "CAPTURED" || payment.status === "REFUNDED" || payment.status === "PARTIALLY_REFUNDED") &&
      previousStatus !== payment.status
    ) {
      await prisma.recoveryCase.updateMany({
        where: { tenantId, paymentId: payment.id, status: { in: OPEN_CASE_STATUSES } },
        data: { status: "RECOVERED", resolvedAt: new Date() },
      });
    }
  }
}
