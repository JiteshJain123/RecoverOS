/**
 * PaymentIntelligenceEngine — the modular-monolith service that ties the pure
 * domain logic (normalize → classify → detect → score) to persistence via the
 * repository ports. It exposes:
 *
 *   - detectForTenant(ctx)   READ-ONLY. Recompute signals from current data.
 *   - summarizeTenant(ctx)   READ-ONLY. Aggregate revenue-at-risk.
 *   - listCandidates(ctx)    READ-ONLY. Persisted recovery cases.
 *   - scanTenant(ctx)        WRITE. Idempotently create/update recovery cases
 *                            and emit audit records. Never executes recovery.
 *
 * Determinism & idempotency:
 *   - All "now" reads go through the injected Clock.
 *   - Candidate generation upserts one case per (tenant, payment). Reprocessing
 *     the same payment updates that case in place — never a duplicate — and
 *     writes NO audit / NO update when nothing substantive changed.
 *
 * Tenant isolation: every method requires a TenantContext and forwards it to
 * every repository call. `assertTenant` rejects an empty context up front.
 */
import type { Logger } from "@recoveros/observability";
import { DETECTION_RULES_VERSION } from "../config";
import { detectSignals, primarySignal } from "../domain/detect";
import { computePriority } from "../domain/score";
import type {
  NormalizedPayment,
  PriorityScore,
  RiskSignal,
  RootCause,
  Severity,
  SignalType,
} from "../domain/types";
import type { PaymentNormalizer } from "../adapters/razorpay";
import type {
  Clock,
  IntelligenceRepository,
  StoredRecoveryCase,
  TenantContext,
} from "./ports";

export interface EngineDeps {
  repo: IntelligenceRepository;
  normalizer: PaymentNormalizer;
  clock: Clock;
  logger?: Logger;
}

export interface PaymentSignals {
  paymentId: string;
  customerId: string | null;
  signals: RiskSignal[];
}

export interface TenantSignalReport {
  tenantId: string;
  generatedAt: string;
  paymentsScanned: number;
  paymentsAtRisk: number;
  signals: RiskSignal[];
  byPayment: PaymentSignals[];
}

export interface RiskSummary {
  tenantId: string;
  generatedAt: string;
  currency: string;
  paymentsAtRisk: number;
  totalAtRiskMinor: number;
  signalCount: number;
  byRootCause: Record<string, { count: number; atRiskMinor: number }>;
  bySeverity: Record<string, number>;
  byType: Record<string, number>;
}

export interface ScanResult {
  tenantId: string;
  scannedPayments: number;
  paymentsAtRisk: number;
  casesCreated: number;
  casesUpdated: number;
  casesUnchanged: number;
}

/** Map the controlled root cause to the coarser RecoveryReason enum. */
function reasonForRootCause(cause: RootCause): string {
  switch (cause) {
    case "CUSTOMER_ABANDONMENT":
    case "EXPIRED_CHECKOUT":
      return "ABANDONED_CHECKOUT";
    default:
      return "FAILED_PAYMENT";
  }
}

export class PaymentIntelligenceEngine {
  private readonly repo: IntelligenceRepository;
  private readonly normalizer: PaymentNormalizer;
  private readonly clock: Clock;
  private readonly logger?: Logger;

  constructor(deps: EngineDeps) {
    this.repo = deps.repo;
    this.normalizer = deps.normalizer;
    this.clock = deps.clock;
    this.logger = deps.logger;
  }

  private assertTenant(ctx: TenantContext): void {
    if (!ctx || typeof ctx.tenantId !== "string" || ctx.tenantId.trim() === "") {
      throw new Error("Tenant context is required for every intelligence operation.");
    }
  }

  /** Normalize all of a tenant's payments and run detection over each. */
  private async detect(ctx: TenantContext): Promise<{
    now: Date;
    normalized: NormalizedPayment[];
    byPayment: PaymentSignals[];
  }> {
    this.assertTenant(ctx);
    const now = this.clock.now();
    const raw = await this.repo.listRawPayments(ctx);
    const normalized = raw.map((r) => this.normalizer.normalize(r));

    const byPayment: PaymentSignals[] = normalized.map((p) => ({
      paymentId: p.paymentId,
      customerId: p.customerId,
      signals: detectSignals(p, { now }),
    }));

    return { now, normalized, byPayment };
  }

  /** READ-ONLY: recompute and return all current risk signals for the tenant. */
  async detectForTenant(ctx: TenantContext): Promise<TenantSignalReport> {
    const { now, byPayment } = await this.detect(ctx);
    const withRisk = byPayment.filter((b) => b.signals.length > 0);
    return {
      tenantId: ctx.tenantId,
      generatedAt: now.toISOString(),
      paymentsScanned: byPayment.length,
      paymentsAtRisk: withRisk.length,
      signals: withRisk.flatMap((b) => b.signals),
      byPayment: withRisk,
    };
  }

  /** READ-ONLY: aggregate revenue-at-risk for the tenant. */
  async summarizeTenant(ctx: TenantContext): Promise<RiskSummary> {
    const { now, normalized, byPayment } = await this.detect(ctx);
    const currency = normalized[0]?.currency ?? "INR";

    const byRootCause: Record<string, { count: number; atRiskMinor: number }> = {};
    const bySeverity: Partial<Record<Severity, number>> = {};
    const byType: Partial<Record<SignalType, number>> = {};
    let totalAtRiskMinor = 0;
    let paymentsAtRisk = 0;
    let signalCount = 0;

    for (const b of byPayment) {
      if (b.signals.length === 0) continue;
      paymentsAtRisk += 1;
      signalCount += b.signals.length;

      for (const s of b.signals) {
        bySeverity[s.severity] = (bySeverity[s.severity] ?? 0) + 1;
        byType[s.type] = (byType[s.type] ?? 0) + 1;
      }

      // Count at-risk revenue once per payment, via its primary signal.
      const primary = primarySignal(b.signals);
      if (primary) {
        totalAtRiskMinor += primary.estimatedRevenueAtRiskMinor;
        const bucket = byRootCause[primary.rootCause] ?? { count: 0, atRiskMinor: 0 };
        bucket.count += 1;
        bucket.atRiskMinor += primary.estimatedRevenueAtRiskMinor;
        byRootCause[primary.rootCause] = bucket;
      }
    }

    return {
      tenantId: ctx.tenantId,
      generatedAt: now.toISOString(),
      currency,
      paymentsAtRisk,
      totalAtRiskMinor,
      signalCount,
      byRootCause,
      bySeverity: bySeverity as Record<string, number>,
      byType: byType as Record<string, number>,
    };
  }

  /** READ-ONLY: persisted recovery candidates (cases) for the tenant. */
  async listCandidates(ctx: TenantContext): Promise<StoredRecoveryCase[]> {
    this.assertTenant(ctx);
    return this.repo.listCases(ctx);
  }

  /**
   * WRITE: idempotently create/update recovery cases from current signals and
   * emit audit records. Safe to run repeatedly.
   */
  async scanTenant(ctx: TenantContext): Promise<ScanResult> {
    const { now, normalized, byPayment } = await this.detect(ctx);
    const signalsByPaymentId = new Map(byPayment.map((b) => [b.paymentId, b.signals]));

    let casesCreated = 0;
    let casesUpdated = 0;
    let casesUnchanged = 0;
    let paymentsAtRisk = 0;

    for (const p of normalized) {
      const signals = signalsByPaymentId.get(p.paymentId) ?? [];
      if (signals.length === 0) continue;
      paymentsAtRisk += 1;

      const primary = primarySignal(signals);
      if (!primary) continue;

      const history = await this.repo.getCustomerHistory(ctx, p.customerId);
      const priority: PriorityScore = computePriority(p, signals, {
        now,
        customerHistory: history,
      });
      const rootCause = primary.rootCause;
      const reason = reasonForRootCause(rootCause);

      const existing = await this.repo.findCaseByPayment(ctx, p.paymentId);

      if (!existing) {
        const created = await this.repo.createCase(ctx, {
          paymentId: p.paymentId,
          customerId: p.customerId,
          reason,
          amountAtRiskMinor: primary.estimatedRevenueAtRiskMinor,
          currency: p.currency,
          rootCause,
          severity: primary.severity,
          priorityScore: priority.score,
          priorityComponents: priority,
          riskSignals: signals,
          detectionRuleVersion: DETECTION_RULES_VERSION,
          detectedAt: now,
        });
        casesCreated += 1;
        await this.repo.appendAudit(ctx, {
          actorType: "SYSTEM",
          action: "intelligence.case.created",
          entityType: "RecoveryCase",
          entityId: created.id,
          summary: `Opened recovery case (${rootCause}, priority ${priority.score}) from ${signals.length} signal(s).`,
          metadata: {
            what: "recovery_case_created",
            why: primary.reason,
            ruleVersion: DETECTION_RULES_VERSION,
            classifier: rootCause,
            priorityScore: priority.score,
            signalTypes: signals.map((s) => s.type),
            paymentId: p.paymentId,
          },
        });
        continue;
      }

      // Existing case: apply intelligence annotations only if something changed.
      const changed =
        existing.priorityScore !== priority.score ||
        existing.rootCause !== rootCause ||
        existing.severity !== primary.severity ||
        existing.detectionRuleVersion !== DETECTION_RULES_VERSION;

      if (!changed) {
        casesUnchanged += 1;
        continue;
      }

      const updated = await this.repo.updateCaseIntelligence(ctx, existing.id, {
        amountAtRiskMinor: primary.estimatedRevenueAtRiskMinor,
        rootCause,
        severity: primary.severity,
        priorityScore: priority.score,
        priorityComponents: priority,
        riskSignals: signals,
        detectionRuleVersion: DETECTION_RULES_VERSION,
        detectedAt: now,
      });
      casesUpdated += 1;
      await this.repo.appendAudit(ctx, {
        actorType: "SYSTEM",
        action: "intelligence.case.updated",
        entityType: "RecoveryCase",
        entityId: updated.id,
        summary: `Updated recovery case intelligence (${rootCause}, priority ${priority.score}).`,
        metadata: {
          what: "recovery_case_intelligence_updated",
          why: primary.reason,
          ruleVersion: DETECTION_RULES_VERSION,
          changed: {
            priorityScore: { from: existing.priorityScore, to: priority.score },
            rootCause: { from: existing.rootCause, to: rootCause },
            detectionRuleVersion: {
              from: existing.detectionRuleVersion,
              to: DETECTION_RULES_VERSION,
            },
          },
          paymentId: p.paymentId,
        },
      });
    }

    const result: ScanResult = {
      tenantId: ctx.tenantId,
      scannedPayments: normalized.length,
      paymentsAtRisk,
      casesCreated,
      casesUpdated,
      casesUnchanged,
    };
    this.logger?.info("intelligence.scan.completed", { ...result });
    return result;
  }
}
