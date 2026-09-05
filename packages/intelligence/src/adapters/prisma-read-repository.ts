/**
 * Prisma-backed IntelligenceReadRepository (production, read-only).
 *
 * Tenant scoping: every query filters by `ctx.tenantId`; id lookups use
 * `(id, tenantId)` so a foreign row reads as "not found". Filtering, sorting,
 * pagination and aggregation are pushed to Postgres (indexed columns). Detail
 * reads use `include` to batch relations — no N+1.
 */
import { prisma, type Prisma } from "@recoveros/database";
import type { RootCause, Severity } from "../domain/types";
import type { TenantContext } from "../engine/ports";
import {
  HIGH_PRIORITY_THRESHOLD,
  OPEN_STATUSES,
  type CaseDetailCore,
  type CaseListPage,
  type IntelligenceReadRepository,
  type PaymentTimelineCore,
  type SummaryAggregates,
} from "../read/read-repository";
import type {
  AuditEntryDTO,
  CaseListItemDTO,
  CaseListQuery,
  CaseStatus,
  DetectedSignalDTO,
  RootCauseBreakdownEntry,
  SeverityBreakdownEntry,
  TimelineEventDTO,
} from "../read/types";

const openFilter = (tenantId: string): Prisma.RecoveryCaseWhereInput => ({
  tenantId,
  status: { in: [...OPEN_STATUSES] } as unknown as Prisma.RecoveryCaseWhereInput["status"],
});

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export class PrismaIntelligenceReadRepository implements IntelligenceReadRepository {
  async summaryAggregates(ctx: TenantContext): Promise<SummaryAggregates> {
    const open = openFilter(ctx.tenantId);

    const [
      openAgg,
      affectedPayments,
      distinctCustomers,
      highPriorityCases,
      reviewRequiredCases,
      recoveredAgg,
      resolvedFailedCount,
      rootCauseGroups,
      severityGroups,
      anyCase,
    ] = await Promise.all([
      prisma.recoveryCase.aggregate({ where: open, _sum: { amountAtRiskMinor: true }, _count: { _all: true } }),
      prisma.recoveryCase.count({ where: { ...open, paymentId: { not: null } } }),
      prisma.recoveryCase.findMany({ where: { ...open, customerId: { not: null } }, distinct: ["customerId"], select: { customerId: true } }),
      prisma.recoveryCase.count({ where: { ...open, priorityScore: { gte: HIGH_PRIORITY_THRESHOLD } } }),
      prisma.recoveryCase.count({
        where: { ...open, OR: [{ status: "PENDING_APPROVAL" }, { severity: "CRITICAL" }] },
      }),
      prisma.recoveryCase.aggregate({ where: { tenantId: ctx.tenantId, status: "RECOVERED" }, _sum: { amountAtRiskMinor: true }, _count: { _all: true } }),
      prisma.recoveryCase.count({ where: { tenantId: ctx.tenantId, status: "FAILED" } }),
      prisma.recoveryCase.groupBy({ by: ["rootCause"], where: open, _count: { _all: true }, _sum: { amountAtRiskMinor: true } }),
      prisma.recoveryCase.groupBy({ by: ["severity"], where: open, _count: { _all: true }, _sum: { amountAtRiskMinor: true } }),
      prisma.recoveryCase.findFirst({ where: { tenantId: ctx.tenantId }, select: { currency: true } }),
    ]);

    const byRootCause: RootCauseBreakdownEntry[] = rootCauseGroups
      .filter((g) => g.rootCause !== null)
      .map((g) => ({
        rootCause: g.rootCause as RootCause,
        cases: g._count._all,
        amountAtRiskMinor: g._sum.amountAtRiskMinor ?? 0,
      }))
      .sort((a, b) => b.amountAtRiskMinor - a.amountAtRiskMinor);

    const bySeverity: SeverityBreakdownEntry[] = severityGroups
      .filter((g) => g.severity !== null)
      .map((g) => ({
        severity: g.severity as Severity,
        cases: g._count._all,
        amountAtRiskMinor: g._sum.amountAtRiskMinor ?? 0,
      }))
      .sort((a, b) => b.amountAtRiskMinor - a.amountAtRiskMinor);

    return {
      currency: anyCase?.currency ?? "INR",
      revenueAtRiskMinor: openAgg._sum.amountAtRiskMinor ?? 0,
      affectedPayments,
      affectedCustomers: distinctCustomers.length,
      highPriorityCases,
      reviewRequiredCases,
      recoveredRevenueMinor: recoveredAgg._sum.amountAtRiskMinor ?? 0,
      resolvedRecoveredCount: recoveredAgg._count._all,
      resolvedFailedCount,
      byRootCause,
      bySeverity,
    };
  }

  async listCases(ctx: TenantContext, query: CaseListQuery): Promise<CaseListPage> {
    const where: Prisma.RecoveryCaseWhereInput = { tenantId: ctx.tenantId };
    if (query.status) where.status = query.status as Prisma.RecoveryCaseWhereInput["status"];
    if (query.severity) where.severity = query.severity as Prisma.RecoveryCaseWhereInput["severity"];
    if (query.rootCause) where.rootCause = query.rootCause as Prisma.RecoveryCaseWhereInput["rootCause"];
    if (query.minAmountMinor !== undefined) where.amountAtRiskMinor = { gte: query.minAmountMinor };
    if (query.minPriority !== undefined) where.priorityScore = { gte: query.minPriority };
    if (query.from || query.to) {
      where.openedAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    // Stable sort: always break ties by id.
    const orderBy: Prisma.RecoveryCaseOrderByWithRelationInput[] =
      query.sort === "amount"
        ? [{ amountAtRiskMinor: "desc" }, { openedAt: "desc" }, { id: "asc" }]
        : query.sort === "recent"
          ? [{ openedAt: "desc" }, { id: "asc" }]
          : [{ priorityScore: { sort: "desc", nulls: "last" } }, { openedAt: "desc" }, { id: "asc" }];

    const [rows, total] = await Promise.all([
      prisma.recoveryCase.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          status: true,
          reason: true,
          rootCause: true,
          severity: true,
          priorityScore: true,
          amountAtRiskMinor: true,
          currency: true,
          paymentId: true,
          customerId: true,
          openedAt: true,
          lastDetectedAt: true,
        },
      }),
      prisma.recoveryCase.count({ where }),
    ]);

    const items: CaseListItemDTO[] = rows.map((r) => ({
      id: r.id,
      status: r.status as CaseStatus,
      reason: r.reason,
      rootCause: (r.rootCause as RootCause | null) ?? null,
      severity: (r.severity as Severity | null) ?? null,
      priorityScore: r.priorityScore,
      amountAtRiskMinor: r.amountAtRiskMinor,
      currency: r.currency,
      paymentId: r.paymentId,
      customerId: r.customerId,
      openedAt: r.openedAt.toISOString(),
      lastDetectedAt: iso(r.lastDetectedAt),
    }));

    return { items, total };
  }

  async getCaseDetail(ctx: TenantContext, caseId: string): Promise<CaseDetailCore | null> {
    const c = await prisma.recoveryCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId },
      include: {
        customer: true,
        payment: { include: { paymentEvents: { orderBy: { occurredAt: "asc" } } } },
        decisions: { orderBy: { createdAt: "asc" } },
        actions: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!c) return null;

    const [history, audits] = await Promise.all([
      c.customerId
        ? prisma.payment.findMany({
            where: { tenantId: ctx.tenantId, customerId: c.customerId },
            orderBy: { createdAt: "desc" },
            take: 20,
            select: { id: true, status: true, amountMinor: true, currency: true, failureCode: true, createdAt: true },
          })
        : Promise.resolve([]),
      prisma.auditLog.findMany({
        where: { tenantId: ctx.tenantId, entityType: "RecoveryCase", entityId: caseId },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const eventTimeline: TimelineEventDTO[] = (c.payment?.paymentEvents ?? []).map((e) => ({
      eventType: e.type,
      rawType: e.rawType,
      occurredAt: e.occurredAt.toISOString(),
    }));

    const auditHistory: AuditEntryDTO[] = audits.map((a) => ({
      id: a.id,
      actorType: a.actorType,
      action: a.action,
      summary: a.summary,
      metadata: a.metadata,
      createdAt: a.createdAt.toISOString(),
    }));

    // Consolidated "why": the most recent intelligence audit's evidence bundle.
    const evidence =
      [...audits]
        .reverse()
        .map((a) => (a.metadata as { evidence?: unknown } | null)?.evidence)
        .find((e) => e !== undefined) ?? null;

    return {
      id: c.id,
      tenantId: c.tenantId,
      status: c.status as CaseStatus,
      reason: c.reason,
      rootCause: (c.rootCause as RootCause | null) ?? null,
      severity: (c.severity as Severity | null) ?? null,
      priorityScore: c.priorityScore,
      amountAtRiskMinor: c.amountAtRiskMinor,
      currency: c.currency,
      openedAt: c.openedAt.toISOString(),
      resolvedAt: iso(c.resolvedAt),
      lastDetectedAt: iso(c.lastDetectedAt),
      detectionRuleVersion: c.detectionRuleVersion,
      customer: c.customer
        ? { id: c.customer.id, name: c.customer.name, email: c.customer.email, phone: c.customer.phone }
        : null,
      payment: c.payment
        ? {
            id: c.payment.id,
            status: c.payment.status,
            method: c.payment.method,
            amountMinor: c.payment.amountMinor,
            currency: c.payment.currency,
            failureCode: c.payment.failureCode,
            failureReason: c.payment.failureReason,
            paymentRef: c.payment.razorpayPaymentId,
            orderRef: c.payment.razorpayOrderId,
            createdAt: c.payment.createdAt.toISOString(),
            capturedAt: iso(c.payment.capturedAt),
          }
        : null,
      paymentHistory: history.map((h) => ({
        id: h.id,
        status: h.status,
        amountMinor: h.amountMinor,
        currency: h.currency,
        failureCode: h.failureCode,
        createdAt: h.createdAt.toISOString(),
      })),
      eventTimeline,
      detectedSignals: (Array.isArray(c.riskSignals) ? c.riskSignals : []) as unknown as DetectedSignalDTO[],
      scoreComponents: c.priorityComponents ?? null,
      evidence,
      recoveryDecisions: c.decisions.map((d) => ({
        id: d.id,
        proposedAction: d.proposedAction,
        amountMinor: d.amountMinor,
        confidence: d.confidence,
        diagnosis: d.diagnosis,
        rationale: d.rationale,
        createdAt: d.createdAt.toISOString(),
      })),
      recoveryActions: c.actions.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        amountMinor: a.amountMinor,
        currency: a.currency,
        policyDecision: a.policyDecision,
        policyVersion: a.policyVersion,
        idempotencyKey: a.idempotencyKey,
        externalReference: a.externalReference,
        createdAt: a.createdAt.toISOString(),
      })),
      auditHistory,
    };
  }

  async getPaymentTimeline(
    ctx: TenantContext,
    paymentId: string,
  ): Promise<PaymentTimelineCore | null> {
    const p = await prisma.payment.findFirst({
      where: { id: paymentId, tenantId: ctx.tenantId },
      include: { paymentEvents: { orderBy: { occurredAt: "asc" } } },
    });
    if (!p) return null;
    return {
      tenantId: ctx.tenantId,
      paymentId: p.id,
      paymentRef: p.razorpayPaymentId,
      status: p.status,
      amountMinor: p.amountMinor,
      currency: p.currency,
      events: p.paymentEvents.map((e) => ({
        eventType: e.type,
        rawType: e.rawType,
        occurredAt: e.occurredAt.toISOString(),
      })),
    };
  }
}
