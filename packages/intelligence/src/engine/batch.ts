/**
 * BatchProcessor — deterministic, idempotent batch processing of a tenant's
 * payments/events into recovery candidates, with controlled stopping conditions,
 * per-case evidence, isolated error handling and structured run logging.
 *
 * It reuses the pure Phase 2 domain logic (normalize → detect → classify →
 * score) and the tenant-scoped repository ports. It does NOT execute recovery,
 * move money, message customers, or create RecoveryDecision/RecoveryAction rows.
 *
 * Idempotency: at most one RecoveryCase per (tenant, payment). Re-running over
 * the same data creates no duplicate cases and re-writes nothing when the
 * computed intelligence is unchanged. Stopping conditions ensure recovered,
 * closed, or in-flight cases are never re-escalated.
 *
 * Determinism: every "now" read goes through the injected Clock; there is no
 * Math.random / Date.now here.
 */
import type { Logger } from "@recoveros/observability";
import { DETECTION_RULES_VERSION, SCORING_FORMULA_VERSION, THRESHOLDS } from "../config";
import { detectSignals, primarySignal } from "../domain/detect";
import { computePriority } from "../domain/score";
import type { NormalizedPayment, PriorityScore, RiskSignal } from "../domain/types";
import type { PaymentNormalizer } from "../adapters/razorpay";
import type { Clock, IntelligenceRepository, StoredRecoveryCase, TenantContext } from "./ports";

/** Advisory next state (never applied to the case by the batch — routing only). */
export type RecommendedNextState =
  | "DETECTED"
  | "ANALYZING"
  | "PROPOSED"
  | "PENDING_APPROVAL";

export interface BatchProcessorConfig {
  /** Payments per batch chunk. */
  batchSize: number;
  /** priorityScore at/above which a case counts as high-priority. */
  highPriorityThreshold: number;
}

export const DEFAULT_BATCH_CONFIG: BatchProcessorConfig = {
  batchSize: 25,
  highPriorityThreshold: 60,
};

export interface BatchProcessorDeps {
  repo: IntelligenceRepository;
  normalizer: PaymentNormalizer;
  clock: Clock;
  logger?: Logger;
  config?: Partial<BatchProcessorConfig>;
  /**
   * Optional monotonic suffix source for run ids, so repeated runs at the same
   * (fixed) clock still get distinct ids. Defaults to an internal counter.
   */
  runIdSuffix?: () => string;
}

/** An error captured for a single payment — surfaced, never swallowed. */
export interface BatchError {
  paymentId: string | null;
  stage: string;
  message: string;
}

export interface BatchRunResult {
  tenantId: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  batches: number;
  totalEventsProcessed: number;
  totalPaymentsProcessed: number;
  currency: string;
  revenueAtRiskMinor: number;
  casesCreated: number;
  casesUpdated: number;
  casesSkipped: number;
  casesAlreadyRecovered: number;
  casesRequiringReview: number;
  highPriorityCases: number;
  errorCount: number;
  errors: BatchError[];
}

/** Case statuses that mean "recovered" — never re-processed. */
const RECOVERED_STATUSES = new Set(["RECOVERED"]);
/** Closed/terminal statuses — do not re-escalate (retry cap, cancellation). */
const CLOSED_STATUSES = new Set(["REJECTED", "EXPIRED", "BLOCKED", "FAILED", "CANCELLED"]);
/** Actively in the human/agent workflow — refresh intelligence, never change status. */
const WORKFLOW_STATUSES = new Set([
  "PENDING_APPROVAL",
  "AUTHORIZED",
  "EXECUTING",
  "PROPOSED",
  "ANALYZING",
]);

type Disposition = "create" | "update" | "unchanged" | "already_recovered" | "closed_skip";

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Deterministic advisory routing for a live at-risk payment. */
function recommendNextState(primary: RiskSignal): RecommendedNextState {
  if (primary.rootCause === "UNKNOWN") return "ANALYZING";
  if (primary.severity === "CRITICAL" || primary.estimatedRevenueAtRiskMinor >= THRESHOLDS.criticalAmountMinor) {
    return "PENDING_APPROVAL";
  }
  const transient =
    primary.rootCause === "TIMEOUT" ||
    primary.rootCause === "GATEWAY_ERROR" ||
    primary.rootCause === "EXPIRED_CHECKOUT";
  if (primary.confidence >= 0.85 && transient) return "PROPOSED";
  if (primary.confidence < 0.6) return "DETECTED";
  return "PROPOSED";
}

/**
 * Build the "why did RecoverOS create this case?" evidence bundle. Includes
 * payment/event references, failure history + timestamps, scoring components
 * and rule versions. Stored in the audit record and returned for inspection.
 */
function buildEvidence(
  p: NormalizedPayment,
  signals: RiskSignal[],
  primary: RiskSignal,
  priority: PriorityScore,
  recommendedNextState: RecommendedNextState,
  runId: string,
): Record<string, unknown> {
  const failureEvents = p.events.filter(
    (e) => e.eventType === "PAYMENT_FAILED" || e.eventType === "SUBSCRIPTION_FAILED",
  );
  return {
    paymentRef: p.paymentRef,
    orderRef: p.orderRef,
    paymentId: p.paymentId,
    customerId: p.customerId,
    failureHistory: {
      retryCount: p.retryCount,
      failureCode: p.failureCode,
      failureReason: p.failureReason,
      failureEvents: failureEvents.map((e) => ({ rawType: e.rawType, occurredAt: e.occurredAt.toISOString() })),
    },
    timestamps: {
      paymentCreatedAt: p.createdAt.toISOString(),
      firstEventAt: p.events[0]?.occurredAt.toISOString() ?? null,
      lastEventAt: p.events[p.events.length - 1]?.occurredAt.toISOString() ?? null,
      detectedAt: primary.detectedAt,
    },
    signalTypes: signals.map((s) => s.type),
    primarySignal: { type: primary.type, severity: primary.severity, confidence: primary.confidence },
    scoring: { score: priority.score, components: priority.components },
    recommendedNextState,
    ruleVersions: {
      detection: DETECTION_RULES_VERSION,
      scoring: SCORING_FORMULA_VERSION,
    },
    batchRunId: runId,
  };
}

export class BatchProcessor {
  private readonly repo: IntelligenceRepository;
  private readonly normalizer: PaymentNormalizer;
  private readonly clock: Clock;
  private readonly logger?: Logger;
  private readonly config: BatchProcessorConfig;
  private readonly runIdSuffix: () => string;
  private counter = 0;

  constructor(deps: BatchProcessorDeps) {
    this.repo = deps.repo;
    this.normalizer = deps.normalizer;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.config = { ...DEFAULT_BATCH_CONFIG, ...deps.config };
    this.runIdSuffix =
      deps.runIdSuffix ??
      (() => {
        this.counter += 1;
        return String(this.counter).padStart(4, "0");
      });
  }

  private assertTenant(ctx: TenantContext): void {
    if (!ctx || typeof ctx.tenantId !== "string" || ctx.tenantId.trim() === "") {
      throw new Error("Tenant context is required for batch processing.");
    }
  }

  private classify(existing: StoredRecoveryCase | null, changed: boolean): Disposition {
    if (!existing) return "create";
    if (RECOVERED_STATUSES.has(existing.status)) return "already_recovered";
    if (CLOSED_STATUSES.has(existing.status)) return "closed_skip";
    // DETECTED (engine-active) or WORKFLOW (in review/flight): refresh annotations
    // only; never advance status. Idempotent when nothing changed.
    if (existing.status === "DETECTED" || WORKFLOW_STATUSES.has(existing.status)) {
      return changed ? "update" : "unchanged";
    }
    // Unknown status: be conservative, do not touch.
    return "closed_skip";
  }

  /**
   * Process one tenant. Every record is handled within `ctx`; a failure on one
   * payment is captured and does not abort the batch.
   */
  async processTenant(ctx: TenantContext): Promise<BatchRunResult> {
    this.assertTenant(ctx);
    const startedAt = this.clock.now();
    const runId = `batch_${ctx.tenantId}_${startedAt.toISOString().replace(/[:.]/g, "")}_${this.runIdSuffix()}`;

    const raw = await this.repo.listRawPayments(ctx);
    const normalized = raw.map((r) => this.normalizer.normalize(r));
    const batches = chunk(normalized, this.config.batchSize);

    const result: BatchRunResult = {
      tenantId: ctx.tenantId,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      batches: batches.length,
      totalEventsProcessed: 0,
      totalPaymentsProcessed: 0,
      currency: normalized[0]?.currency ?? "INR",
      revenueAtRiskMinor: 0,
      casesCreated: 0,
      casesUpdated: 0,
      casesSkipped: 0,
      casesAlreadyRecovered: 0,
      casesRequiringReview: 0,
      highPriorityCases: 0,
      errorCount: 0,
      errors: [],
    };

    this.logger?.info("batch.run.started", {
      tenantId: ctx.tenantId,
      runId,
      payments: normalized.length,
      batches: batches.length,
    });

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b] as NormalizedPayment[];
      for (const p of batch) {
        try {
          await this.processPayment(ctx, p, runId, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown_error";
          result.errorCount += 1;
          result.errors.push({ paymentId: p.paymentId, stage: "process_payment", message });
          this.logger?.error("batch.payment.failed", {
            tenantId: ctx.tenantId,
            runId,
            paymentId: p.paymentId,
            message,
          });
        }
      }
      this.logger?.debug("batch.chunk.completed", {
        tenantId: ctx.tenantId,
        runId,
        batch: b + 1,
        of: batches.length,
      });
    }

    const finishedAt = this.clock.now();
    result.finishedAt = finishedAt.toISOString();
    result.durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

    // Structured run summary (no secrets — only ids, counts, money-at-risk).
    this.logger?.info("batch.run.completed", {
      tenantId: ctx.tenantId,
      runId,
      eventCount: result.totalEventsProcessed,
      paymentCount: result.totalPaymentsProcessed,
      casesCreated: result.casesCreated,
      casesUpdated: result.casesUpdated,
      casesSkipped: result.casesSkipped,
      revenueAtRiskMinor: result.revenueAtRiskMinor,
      highPriorityCases: result.highPriorityCases,
      durationMs: result.durationMs,
      errorCount: result.errorCount,
    });

    return result;
  }

  private async processPayment(
    ctx: TenantContext,
    p: NormalizedPayment,
    runId: string,
    result: BatchRunResult,
  ): Promise<void> {
    result.totalPaymentsProcessed += 1;
    result.totalEventsProcessed += p.events.length;

    const now = this.clock.now();
    const signals = detectSignals(p, { now });
    if (signals.length === 0) return; // not revenue-at-risk → nothing to do.

    const primary = primarySignal(signals);
    if (!primary) return;

    const existing = await this.repo.findCaseByPayment(ctx, p.paymentId);

    // Stopping conditions BEFORE any scoring/writes.
    if (existing && RECOVERED_STATUSES.has(existing.status)) {
      result.casesAlreadyRecovered += 1;
      return;
    }
    if (existing && CLOSED_STATUSES.has(existing.status)) {
      result.casesSkipped += 1;
      return;
    }

    const history = await this.repo.getCustomerHistory(ctx, p.customerId);
    const priority = computePriority(p, signals, { now, customerHistory: history });
    const recommendedNextState = recommendNextState(primary);
    const rootCause = primary.rootCause;
    const reason = rootCause === "CUSTOMER_ABANDONMENT" || rootCause === "EXPIRED_CHECKOUT" ? "ABANDONED_CHECKOUT" : "FAILED_PAYMENT";

    const changed =
      !existing ||
      existing.priorityScore !== priority.score ||
      existing.rootCause !== rootCause ||
      existing.severity !== primary.severity ||
      existing.detectionRuleVersion !== DETECTION_RULES_VERSION;

    const disposition = this.classify(existing, changed);
    const evidence = buildEvidence(p, signals, primary, priority, recommendedNextState, runId);

    // This payment is a live at-risk case (created/updated/unchanged-open) →
    // count its revenue-at-risk and cross-cutting buckets exactly once.
    const live = disposition === "create" || disposition === "update" || disposition === "unchanged";
    if (live) {
      result.revenueAtRiskMinor += primary.estimatedRevenueAtRiskMinor;
      if (priority.score >= this.config.highPriorityThreshold) result.highPriorityCases += 1;
      if (recommendedNextState === "PENDING_APPROVAL") result.casesRequiringReview += 1;
    }

    if (disposition === "create") {
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
      result.casesCreated += 1;
      await this.repo.appendAudit(ctx, {
        actorType: "SYSTEM",
        action: "intelligence.batch.case.created",
        entityType: "RecoveryCase",
        entityId: created.id,
        summary: `Batch opened recovery case (${rootCause}, priority ${priority.score}, next=${recommendedNextState}).`,
        metadata: { what: "recovery_case_created", why: primary.reason, evidence },
      });
      return;
    }

    if (disposition === "update" && existing) {
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
      result.casesUpdated += 1;
      await this.repo.appendAudit(ctx, {
        actorType: "SYSTEM",
        action: "intelligence.batch.case.updated",
        entityType: "RecoveryCase",
        entityId: updated.id,
        summary: `Batch refreshed case intelligence (${rootCause}, priority ${priority.score}).`,
        metadata: {
          what: "recovery_case_intelligence_updated",
          why: primary.reason,
          changed: {
            priorityScore: { from: existing.priorityScore, to: priority.score },
            rootCause: { from: existing.rootCause, to: rootCause },
          },
          evidence,
        },
      });
      return;
    }

    // disposition === "unchanged": idempotent no-op (already annotated).
    result.casesSkipped += 1;
  }

  /** Convenience: process several tenants, each in its own context. */
  async processTenants(tenantIds: readonly string[]): Promise<BatchRunResult[]> {
    const results: BatchRunResult[] = [];
    for (const tenantId of tenantIds) {
      results.push(await this.processTenant({ tenantId }));
    }
    return results;
  }
}
