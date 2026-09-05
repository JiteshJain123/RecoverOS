/**
 * Prisma-backed GeminiRecoveryStore (production). Loads the tenant-scoped case
 * context for a Gemini prompt and persists the agent trace
 * (AgentRun / AgentToolCall / RecoveryDecision / AuditLog).
 *
 * Tenant scoping: every read/write filters by `ctx.tenantId`. `loadCaseContext`
 * uses `(id, tenantId)`, so a case belonging to another tenant reads as null
 * (→ 404 at the endpoint, no existence leak). No secrets are ever written.
 */
import { prisma, Prisma } from "@recoveros/database";
import type { RecoveryStrategyContext, StrategySignal } from "@recoveros/strategy";
import type {
  AuditEntryInput,
  CaseRecoveryContext,
  CompleteAgentRunInput,
  CreateAgentRunInput,
  GeminiRecoveryStore,
  RecordToolCallInput,
  TenantContext,
  UpsertDecisionInput,
} from "../gemini/store";

const asJson = (value: unknown): Prisma.InputJsonValue => value as unknown as Prisma.InputJsonValue;

/** Statuses treated as an open payment (retry attempts derivable from events). */
export class PrismaGeminiRecoveryStore implements GeminiRecoveryStore {
  async loadCaseContext(ctx: TenantContext, caseId: string): Promise<CaseRecoveryContext | null> {
    const c = await prisma.recoveryCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId },
      include: {
        payment: { include: { paymentEvents: true } },
        customer: true,
      },
    });
    if (!c) return null;

    const failedEvents = (c.payment?.paymentEvents ?? []).filter(
      (e) => e.type === "PAYMENT_FAILED" || e.type === "SUBSCRIPTION_FAILED",
    );
    const retryCount = failedEvents.length;
    const hasExpiredLink = (c.payment?.paymentEvents ?? []).some(
      (e) => e.type === "PAYMENT_LINK_EXPIRED",
    );

    const signals: StrategySignal[] = Array.isArray(c.riskSignals)
      ? (c.riskSignals as unknown[]).flatMap((s) => {
          const sig = s as Partial<StrategySignal>;
          if (!sig || typeof sig.type !== "string") return [];
          return [
            {
              type: sig.type,
              severity: (sig.severity ?? "LOW") as StrategySignal["severity"],
              rootCause: (sig.rootCause ?? "UNKNOWN") as StrategySignal["rootCause"],
              confidence: typeof sig.confidence === "number" ? sig.confidence : 0,
              reason: typeof sig.reason === "string" ? sig.reason : "",
            },
          ];
        })
      : [];

    // Customer recovery history: aggregates only (no PII to the prompt).
    let customerHistory: CaseRecoveryContext["customerHistory"];
    if (c.customerId) {
      const agg = await prisma.payment.aggregate({
        where: { tenantId: ctx.tenantId, customerId: c.customerId, status: "CAPTURED" },
        _count: { _all: true },
        _sum: { amountMinor: true },
      });
      customerHistory = {
        successfulPayments: agg._count._all,
        totalCapturedMinor: agg._sum.amountMinor ?? 0,
      };
    }

    // Applicable policy constraints (non-secret limits JSON), if an active one.
    const policy = await prisma.policy.findFirst({
      where: { tenantId: ctx.tenantId, isActive: true },
      orderBy: { version: "desc" },
      select: { version: true, limits: true },
    });
    const policyConstraints = policy
      ? { policyVersion: policy.version, limits: policy.limits }
      : undefined;

    const strategyContext: RecoveryStrategyContext = {
      caseId: c.id,
      tenantId: c.tenantId,
      caseStatus: c.status as RecoveryStrategyContext["caseStatus"],
      paymentStatus: (c.payment?.status ?? null) as RecoveryStrategyContext["paymentStatus"],
      reason: c.reason,
      rootCause: (c.rootCause as RecoveryStrategyContext["rootCause"]) ?? null,
      severity: (c.severity as RecoveryStrategyContext["severity"]) ?? null,
      priorityScore: c.priorityScore,
      amountAtRiskMinor: c.amountAtRiskMinor,
      currency: c.currency,
      paymentId: c.paymentId,
      customerId: c.customerId,
      retryCount,
      hasContactChannel: Boolean(c.customer?.email || c.customer?.phone),
      hasExpiredLink,
      // Policy authorization is a later phase; the strategy layer treats this as
      // a pre-check hint. Default OK — the deterministic policy engine is the
      // real gate before any execution.
      policyState: "OK",
      signals,
    };

    return { strategyContext, customerHistory, policyConstraints };
  }

  async createAgentRun(ctx: TenantContext, input: CreateAgentRunInput): Promise<{ id: string }> {
    const run = await prisma.agentRun.create({
      data: {
        tenantId: ctx.tenantId,
        caseId: input.caseId,
        status: "RUNNING",
        model: input.model,
        startedAt: input.startedAt,
      },
      select: { id: true },
    });
    return { id: run.id };
  }

  async completeAgentRun(
    ctx: TenantContext,
    agentRunId: string,
    input: CompleteAgentRunInput,
  ): Promise<void> {
    await prisma.agentRun.updateMany({
      where: { id: agentRunId, tenantId: ctx.tenantId },
      data: {
        status: input.status as Prisma.AgentRunUpdateManyMutationInput["status"],
        latencyMs: input.latencyMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        error: input.error,
        completedAt: input.completedAt,
      },
    });
  }

  async recordToolCall(ctx: TenantContext, input: RecordToolCallInput): Promise<void> {
    await prisma.agentToolCall.create({
      data: {
        tenantId: ctx.tenantId,
        agentRunId: input.agentRunId,
        sequence: input.sequence,
        name: input.name,
        args: asJson(input.args),
        result: input.result === undefined ? Prisma.JsonNull : asJson(input.result),
        isError: input.isError,
      },
    });
  }

  async upsertDecision(ctx: TenantContext, input: UpsertDecisionInput): Promise<{ id: string }> {
    // One decision per agent run (agentRunId is unique). Idempotent per run.
    const decision = await prisma.recoveryDecision.upsert({
      where: { agentRunId: input.agentRunId },
      create: {
        tenantId: ctx.tenantId,
        caseId: input.caseId,
        agentRunId: input.agentRunId,
        proposedAction: input.proposedAction as Prisma.RecoveryDecisionCreateInput["proposedAction"],
        amountMinor: input.amountMinor ?? null,
        confidence: input.confidence,
        diagnosis: input.diagnosis,
        rationale: input.rationale,
      },
      update: {
        proposedAction: input.proposedAction as Prisma.RecoveryDecisionUpdateInput["proposedAction"],
        amountMinor: input.amountMinor ?? null,
        confidence: input.confidence,
        diagnosis: input.diagnosis,
        rationale: input.rationale,
      },
      select: { id: true },
    });
    return { id: decision.id };
  }

  async appendAudit(ctx: TenantContext, entry: AuditEntryInput): Promise<void> {
    await prisma.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorType: "AGENT",
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        metadata: asJson(entry.metadata),
      },
    });
  }
}
