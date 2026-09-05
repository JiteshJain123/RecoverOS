/**
 * In-memory IntelligenceReadRepository for API tests. Mirrors the Prisma
 * adapter's tenant scoping and filter/sort/paginate/aggregate semantics over
 * plain arrays — no database required. Enforces the same isolation invariant:
 * a query for the wrong tenant sees nothing.
 */
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
import type { RootCause, Severity } from "../domain/types";
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

export interface MemPaymentEvent {
  eventType: string;
  rawType: string;
  occurredAt: string;
}
export interface MemPayment {
  id: string;
  tenantId: string;
  customerId: string | null;
  status: string;
  method: string | null;
  amountMinor: number;
  currency: string;
  failureCode: string | null;
  failureReason: string | null;
  paymentRef: string | null;
  orderRef: string | null;
  createdAt: string;
  capturedAt: string | null;
  events: MemPaymentEvent[];
}
export interface MemCustomer {
  id: string;
  tenantId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}
export interface MemCase {
  id: string;
  tenantId: string;
  paymentId: string | null;
  customerId: string | null;
  status: CaseStatus;
  reason: string;
  rootCause: RootCause | null;
  severity: Severity | null;
  priorityScore: number | null;
  amountAtRiskMinor: number;
  currency: string;
  openedAt: string;
  resolvedAt: string | null;
  lastDetectedAt: string | null;
  detectionRuleVersion: string | null;
  riskSignals: DetectedSignalDTO[];
  priorityComponents: unknown;
}
export interface MemDecision {
  id: string;
  tenantId: string;
  caseId: string;
  proposedAction: string;
  amountMinor: number | null;
  confidence: number;
  diagnosis: string;
  rationale: string;
  createdAt: string;
}
export interface MemAction {
  id: string;
  tenantId: string;
  caseId: string;
  type: string;
  status: string;
  amountMinor: number | null;
  currency: string;
  policyDecision: string | null;
  policyVersion: number | null;
  idempotencyKey: string;
  externalReference: string | null;
  createdAt: string;
}
export interface MemAudit {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  actorType: string;
  action: string;
  summary: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface InMemoryReadSeed {
  cases?: MemCase[];
  payments?: MemPayment[];
  customers?: MemCustomer[];
  decisions?: MemDecision[];
  actions?: MemAction[];
  audits?: MemAudit[];
}

const isOpen = (status: string): boolean =>
  (OPEN_STATUSES as readonly string[]).includes(status);

export class InMemoryReadRepository implements IntelligenceReadRepository {
  private readonly cases: MemCase[];
  private readonly payments: MemPayment[];
  private readonly customers: MemCustomer[];
  private readonly decisions: MemDecision[];
  private readonly actions: MemAction[];
  private readonly audits: MemAudit[];

  constructor(seed: InMemoryReadSeed = {}) {
    this.cases = seed.cases ?? [];
    this.payments = seed.payments ?? [];
    this.customers = seed.customers ?? [];
    this.decisions = seed.decisions ?? [];
    this.actions = seed.actions ?? [];
    this.audits = seed.audits ?? [];
  }

  private tenantCases(tenantId: string): MemCase[] {
    return this.cases.filter((c) => c.tenantId === tenantId);
  }

  async summaryAggregates(ctx: TenantContext): Promise<SummaryAggregates> {
    const all = this.tenantCases(ctx.tenantId);
    const open = all.filter((c) => isOpen(c.status));
    const recovered = all.filter((c) => c.status === "RECOVERED");

    const group = (
      key: "rootCause" | "severity",
    ): Map<string, { cases: number; amountAtRiskMinor: number }> => {
      const m = new Map<string, { cases: number; amountAtRiskMinor: number }>();
      for (const c of open) {
        const v = c[key];
        if (v == null) continue;
        const b = m.get(v) ?? { cases: 0, amountAtRiskMinor: 0 };
        b.cases += 1;
        b.amountAtRiskMinor += c.amountAtRiskMinor;
        m.set(v, b);
      }
      return m;
    };

    const byRootCause: RootCauseBreakdownEntry[] = [...group("rootCause").entries()]
      .map(([rootCause, v]) => ({ rootCause: rootCause as RootCause, ...v }))
      .sort((a, b) => b.amountAtRiskMinor - a.amountAtRiskMinor);
    const bySeverity: SeverityBreakdownEntry[] = [...group("severity").entries()]
      .map(([severity, v]) => ({ severity: severity as Severity, ...v }))
      .sort((a, b) => b.amountAtRiskMinor - a.amountAtRiskMinor);

    return {
      currency: all[0]?.currency ?? "INR",
      revenueAtRiskMinor: open.reduce((s, c) => s + c.amountAtRiskMinor, 0),
      affectedPayments: open.filter((c) => c.paymentId != null).length,
      affectedCustomers: new Set(open.map((c) => c.customerId).filter((x): x is string => x != null)).size,
      highPriorityCases: open.filter((c) => (c.priorityScore ?? -1) >= HIGH_PRIORITY_THRESHOLD).length,
      reviewRequiredCases: open.filter((c) => c.status === "PENDING_APPROVAL" || c.severity === "CRITICAL").length,
      recoveredRevenueMinor: recovered.reduce((s, c) => s + c.amountAtRiskMinor, 0),
      resolvedRecoveredCount: recovered.length,
      resolvedFailedCount: all.filter((c) => c.status === "FAILED").length,
      byRootCause,
      bySeverity,
    };
  }

  async listCases(ctx: TenantContext, q: CaseListQuery): Promise<CaseListPage> {
    let rows = this.tenantCases(ctx.tenantId);
    if (q.status) rows = rows.filter((c) => c.status === q.status);
    if (q.severity) rows = rows.filter((c) => c.severity === q.severity);
    if (q.rootCause) rows = rows.filter((c) => c.rootCause === q.rootCause);
    if (q.minAmountMinor !== undefined) rows = rows.filter((c) => c.amountAtRiskMinor >= q.minAmountMinor!);
    if (q.minPriority !== undefined) rows = rows.filter((c) => (c.priorityScore ?? -1) >= q.minPriority!);
    if (q.from) rows = rows.filter((c) => Date.parse(c.openedAt) >= Date.parse(q.from!));
    if (q.to) rows = rows.filter((c) => Date.parse(c.openedAt) <= Date.parse(q.to!));

    const byOpenedDescIdAsc = (a: MemCase, b: MemCase): number =>
      Date.parse(b.openedAt) - Date.parse(a.openedAt) || a.id.localeCompare(b.id);
    rows = [...rows].sort((a, b) => {
      if (q.sort === "amount") return b.amountAtRiskMinor - a.amountAtRiskMinor || byOpenedDescIdAsc(a, b);
      if (q.sort === "recent") return byOpenedDescIdAsc(a, b);
      return (b.priorityScore ?? -Infinity) - (a.priorityScore ?? -Infinity) || byOpenedDescIdAsc(a, b);
    });

    const total = rows.length;
    const start = (q.page - 1) * q.pageSize;
    const items: CaseListItemDTO[] = rows.slice(start, start + q.pageSize).map((c) => ({
      id: c.id,
      status: c.status,
      reason: c.reason,
      rootCause: c.rootCause,
      severity: c.severity,
      priorityScore: c.priorityScore,
      amountAtRiskMinor: c.amountAtRiskMinor,
      currency: c.currency,
      paymentId: c.paymentId,
      customerId: c.customerId,
      openedAt: c.openedAt,
      lastDetectedAt: c.lastDetectedAt,
    }));
    return { items, total };
  }

  async getCaseDetail(ctx: TenantContext, caseId: string): Promise<CaseDetailCore | null> {
    const c = this.tenantCases(ctx.tenantId).find((x) => x.id === caseId);
    if (!c) return null;

    const payment = this.payments.find((p) => p.tenantId === ctx.tenantId && p.id === c.paymentId) ?? null;
    const customer = this.customers.find((x) => x.tenantId === ctx.tenantId && x.id === c.customerId) ?? null;
    const history = c.customerId
      ? this.payments
          .filter((p) => p.tenantId === ctx.tenantId && p.customerId === c.customerId)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .slice(0, 20)
      : [];
    const audits = this.audits
      .filter((a) => a.tenantId === ctx.tenantId && a.entityType === "RecoveryCase" && a.entityId === caseId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    const eventTimeline: TimelineEventDTO[] = (payment?.events ?? []).map((e) => ({ ...e }));
    const auditHistory: AuditEntryDTO[] = audits.map((a) => ({
      id: a.id,
      actorType: a.actorType,
      action: a.action,
      summary: a.summary,
      metadata: a.metadata,
      createdAt: a.createdAt,
    }));
    const evidence =
      [...audits]
        .reverse()
        .map((a) => (a.metadata as { evidence?: unknown } | null)?.evidence)
        .find((e) => e !== undefined) ?? null;

    return {
      id: c.id,
      tenantId: c.tenantId,
      status: c.status,
      reason: c.reason,
      rootCause: c.rootCause,
      severity: c.severity,
      priorityScore: c.priorityScore,
      amountAtRiskMinor: c.amountAtRiskMinor,
      currency: c.currency,
      openedAt: c.openedAt,
      resolvedAt: c.resolvedAt,
      lastDetectedAt: c.lastDetectedAt,
      detectionRuleVersion: c.detectionRuleVersion,
      customer: customer
        ? { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone }
        : null,
      payment: payment
        ? {
            id: payment.id,
            status: payment.status,
            method: payment.method,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            failureCode: payment.failureCode,
            failureReason: payment.failureReason,
            paymentRef: payment.paymentRef,
            orderRef: payment.orderRef,
            createdAt: payment.createdAt,
            capturedAt: payment.capturedAt,
          }
        : null,
      paymentHistory: history.map((h) => ({
        id: h.id,
        status: h.status,
        amountMinor: h.amountMinor,
        currency: h.currency,
        failureCode: h.failureCode,
        createdAt: h.createdAt,
      })),
      eventTimeline,
      detectedSignals: c.riskSignals,
      scoreComponents: c.priorityComponents ?? null,
      evidence,
      recoveryDecisions: this.decisions
        .filter((d) => d.tenantId === ctx.tenantId && d.caseId === caseId)
        .map((d) => ({
          id: d.id,
          proposedAction: d.proposedAction,
          amountMinor: d.amountMinor,
          confidence: d.confidence,
          diagnosis: d.diagnosis,
          rationale: d.rationale,
          createdAt: d.createdAt,
        })),
      recoveryActions: this.actions
        .filter((a) => a.tenantId === ctx.tenantId && a.caseId === caseId)
        .map((a) => ({
          id: a.id,
          type: a.type,
          status: a.status,
          amountMinor: a.amountMinor,
          currency: a.currency,
          policyDecision: a.policyDecision,
          policyVersion: a.policyVersion,
          idempotencyKey: a.idempotencyKey,
          externalReference: a.externalReference,
          createdAt: a.createdAt,
        })),
      auditHistory,
    };
  }

  async getPaymentTimeline(
    ctx: TenantContext,
    paymentId: string,
  ): Promise<PaymentTimelineCore | null> {
    const p = this.payments.find((x) => x.tenantId === ctx.tenantId && x.id === paymentId);
    if (!p) return null;
    return {
      tenantId: ctx.tenantId,
      paymentId: p.id,
      paymentRef: p.paymentRef,
      status: p.status,
      amountMinor: p.amountMinor,
      currency: p.currency,
      events: p.events.map((e) => ({ ...e })),
    };
  }
}
