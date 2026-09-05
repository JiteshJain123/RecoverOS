/**
 * Prisma-backed IntelligenceRepository (production adapter).
 *
 * Every query is scoped by `ctx.tenantId` — there is no path that reads or
 * writes tenant-owned rows by bare id without the tenant filter. Writes to a
 * specific case use `updateMany({ where: { id, tenantId } })` so a mismatched
 * tenant simply affects zero rows rather than another tenant's data.
 */
import { prisma, Prisma } from "@recoveros/database";
import type { CustomerHistory } from "../domain/score";
import type { RootCause, Severity } from "../domain/types";
import type { RawProviderPayment } from "./razorpay";
import type {
  AuditEntry,
  CaseIntelligencePatch,
  CreateCaseInput,
  IntelligenceRepository,
  StoredRecoveryCase,
  TenantContext,
} from "../engine/ports";

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as unknown as Prisma.InputJsonValue;

export class PrismaIntelligenceRepository implements IntelligenceRepository {
  async listRawPayments(ctx: TenantContext): Promise<RawProviderPayment[]> {
    const rows = await prisma.payment.findMany({
      where: { tenantId: ctx.tenantId },
      include: { paymentEvents: { orderBy: { occurredAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });

    return rows.map((p) => ({
      tenantId: p.tenantId,
      id: p.id,
      customerId: p.customerId,
      razorpayPaymentId: p.razorpayPaymentId,
      razorpayOrderId: p.razorpayOrderId,
      razorpayCustomerId: null,
      status: p.status,
      failureCode: p.failureCode,
      failureReason: p.failureReason,
      amountMinor: p.amountMinor,
      currency: p.currency,
      capturedAt: p.capturedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      events: p.paymentEvents.map((e) => ({
        type: e.type,
        rawType: e.rawType,
        occurredAt: e.occurredAt,
      })),
    }));
  }

  async getCustomerHistory(
    ctx: TenantContext,
    customerId: string | null,
  ): Promise<CustomerHistory> {
    if (!customerId) return { successfulPayments: 0, totalCapturedMinor: 0 };
    const agg = await prisma.payment.aggregate({
      where: { tenantId: ctx.tenantId, customerId, status: "CAPTURED" },
      _count: { _all: true },
      _sum: { amountMinor: true },
    });
    return {
      successfulPayments: agg._count._all,
      totalCapturedMinor: agg._sum.amountMinor ?? 0,
    };
  }

  async findCaseByPayment(
    ctx: TenantContext,
    paymentId: string,
  ): Promise<StoredRecoveryCase | null> {
    const c = await prisma.recoveryCase.findFirst({
      where: { tenantId: ctx.tenantId, paymentId },
    });
    return c ? toStored(c) : null;
  }

  async createCase(ctx: TenantContext, input: CreateCaseInput): Promise<StoredRecoveryCase> {
    const c = await prisma.recoveryCase.create({
      data: {
        tenantId: ctx.tenantId,
        paymentId: input.paymentId,
        customerId: input.customerId,
        reason: input.reason as Prisma.RecoveryCaseCreateInput["reason"],
        status: "DETECTED",
        amountAtRiskMinor: input.amountAtRiskMinor,
        currency: input.currency,
        rootCause: input.rootCause as Prisma.RecoveryCaseCreateInput["rootCause"],
        severity: input.severity as Prisma.RecoveryCaseCreateInput["severity"],
        priorityScore: input.priorityScore,
        priorityComponents: asJson(input.priorityComponents),
        riskSignals: asJson(input.riskSignals),
        detectionRuleVersion: input.detectionRuleVersion,
        lastDetectedAt: input.detectedAt,
        openedAt: input.detectedAt,
      },
    });
    return toStored(c);
  }

  async updateCaseIntelligence(
    ctx: TenantContext,
    caseId: string,
    patch: CaseIntelligencePatch,
  ): Promise<StoredRecoveryCase> {
    const res = await prisma.recoveryCase.updateMany({
      where: { id: caseId, tenantId: ctx.tenantId },
      data: {
        amountAtRiskMinor: patch.amountAtRiskMinor,
        rootCause: patch.rootCause as Prisma.RecoveryCaseUpdateInput["rootCause"],
        severity: patch.severity as Prisma.RecoveryCaseUpdateInput["severity"],
        priorityScore: patch.priorityScore,
        priorityComponents: asJson(patch.priorityComponents),
        riskSignals: asJson(patch.riskSignals),
        detectionRuleVersion: patch.detectionRuleVersion,
        lastDetectedAt: patch.detectedAt,
      },
    });
    if (res.count === 0) {
      throw new Error(`Case ${caseId} not found for tenant ${ctx.tenantId}.`);
    }
    const c = await prisma.recoveryCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId },
    });
    if (!c) throw new Error(`Case ${caseId} vanished after update.`);
    return toStored(c);
  }

  async listCases(ctx: TenantContext): Promise<StoredRecoveryCase[]> {
    const rows = await prisma.recoveryCase.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: [{ priorityScore: { sort: "desc", nulls: "last" } }, { openedAt: "desc" }],
    });
    return rows.map(toStored);
  }

  async appendAudit(ctx: TenantContext, entry: AuditEntry): Promise<void> {
    await prisma.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorType: entry.actorType,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        metadata: asJson(entry.metadata),
      },
    });
  }
}

/** Map a Prisma recovery_cases row to the engine's StoredRecoveryCase. */
function toStored(c: {
  id: string;
  tenantId: string;
  paymentId: string | null;
  customerId: string | null;
  reason: string;
  status: string;
  amountAtRiskMinor: number;
  currency: string;
  rootCause: string | null;
  severity: string | null;
  priorityScore: number | null;
  priorityComponents: unknown;
  riskSignals: unknown;
  detectionRuleVersion: string | null;
  lastDetectedAt: Date | null;
}): StoredRecoveryCase {
  return {
    id: c.id,
    tenantId: c.tenantId,
    paymentId: c.paymentId,
    customerId: c.customerId,
    reason: c.reason,
    status: c.status,
    amountAtRiskMinor: c.amountAtRiskMinor,
    currency: c.currency,
    rootCause: (c.rootCause as RootCause | null) ?? null,
    severity: (c.severity as Severity | null) ?? null,
    priorityScore: c.priorityScore,
    priorityComponents: c.priorityComponents ?? null,
    riskSignals: c.riskSignals ?? null,
    detectionRuleVersion: c.detectionRuleVersion,
    lastDetectedAt: c.lastDetectedAt,
    createdByEngine: c.detectionRuleVersion !== null,
  };
}
