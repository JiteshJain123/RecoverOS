/**
 * Prisma-backed ExecutionStore + RecoveryCaseSource (production; dev endpoints).
 *
 * Tenant scoping: every read/write filters by `ctx.tenantId`; id lookups use
 * `(id, tenantId)` so a foreign row is invisible. The domain ActionState is
 * mapped to the Prisma `RecoveryActionStatus` enum. The action's execution
 * expiry (not a column) is carried inside `policyReasons` JSON.
 *
 * These adapters are only used behind the development-only endpoints; the pure
 * executor/approval/pipeline logic is exercised via the in-memory store.
 */
import { prisma, Prisma } from "@recoveros/database";
import type { PolicyActionType, PolicyDecisionType, PolicyLimits } from "@recoveros/policy";
import type { RecoveryStrategyContext, StrategySignal } from "@recoveros/strategy";
import type {
  ActionPatch,
  ActionRecord,
  CreateActionInput,
  ExecAuditEntry,
  ExecCasePatch,
  ExecCaseRecord,
  ExecTenantContext,
  ExecutionStore,
} from "../store";
import type { PipelineCase, RecoveryCaseSource } from "../pipeline";
import type { ActionState } from "../state-machine";

const asJson = (v: unknown): Prisma.InputJsonValue => v as unknown as Prisma.InputJsonValue;

/** Domain ActionState ↔ Prisma RecoveryActionStatus. */
const STATE_TO_PRISMA: Record<ActionState, string> = {
  PROPOSED: "PROPOSED",
  APPROVAL_REQUIRED: "AWAITING_APPROVAL",
  APPROVED: "AUTHORIZED",
  EXECUTING: "EXECUTING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
};
const PRISMA_TO_STATE: Record<string, ActionState> = {
  PROPOSED: "PROPOSED",
  AWAITING_APPROVAL: "APPROVAL_REQUIRED",
  AUTHORIZED: "APPROVED",
  BLOCKED: "FAILED",
  REJECTED: "CANCELLED",
  EXECUTING: "EXECUTING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
};

interface ActionRow {
  id: string;
  tenantId: string;
  caseId: string;
  decisionId: string | null;
  idempotencyKey: string;
  type: string;
  amountMinor: number | null;
  currency: string;
  status: string;
  policyDecision: string | null;
  policyReasons: unknown;
  policyVersion: number | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  executedAt: Date | null;
  completedAt: Date | null;
  externalReference: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(r: ActionRow): ActionRecord {
  const reasons = (r.policyReasons ?? {}) as {
    expiresAt?: string;
    riskLevel?: string;
    recoveredAmountMinor?: number;
  };
  return {
    id: r.id,
    tenantId: r.tenantId,
    caseId: r.caseId,
    decisionId: r.decisionId,
    idempotencyKey: r.idempotencyKey,
    actionType: r.type as PolicyActionType,
    amountMinor: r.amountMinor,
    currency: r.currency,
    state: PRISMA_TO_STATE[r.status] ?? "PROPOSED",
    policyDecision: (r.policyDecision as PolicyDecisionType) ?? "BLOCK",
    policyVersion: r.policyVersion,
    riskLevel: reasons.riskLevel ?? "MEDIUM",
    approvedByUserId: r.approvedByUserId,
    approvedAt: r.approvedAt,
    executedAt: r.executedAt,
    completedAt: r.completedAt,
    externalReference: r.externalReference,
    failureReason: r.failureReason,
    recoveredAmountMinor: typeof reasons.recoveredAmountMinor === "number" ? reasons.recoveredAmountMinor : null,
    expiresAt: reasons.expiresAt ? new Date(reasons.expiresAt) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class PrismaExecutionStore implements ExecutionStore {
  async findActionByIdempotencyKey(ctx: ExecTenantContext, key: string): Promise<ActionRecord | null> {
    const r = await prisma.recoveryAction.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: key } });
    return r ? toRecord(r as unknown as ActionRow) : null;
  }

  async getAction(ctx: ExecTenantContext, id: string): Promise<ActionRecord | null> {
    const r = await prisma.recoveryAction.findFirst({ where: { id, tenantId: ctx.tenantId } });
    return r ? toRecord(r as unknown as ActionRow) : null;
  }

  async createAction(ctx: ExecTenantContext, input: CreateActionInput): Promise<ActionRecord> {
    const r = await prisma.recoveryAction.create({
      data: {
        tenantId: ctx.tenantId,
        caseId: input.caseId,
        decisionId: input.decisionId,
        idempotencyKey: input.idempotencyKey,
        type: input.actionType as Prisma.RecoveryActionCreateInput["type"],
        status: STATE_TO_PRISMA[input.state] as Prisma.RecoveryActionCreateInput["status"],
        amountMinor: input.amountMinor,
        currency: input.currency,
        policyDecision: input.policyDecision as Prisma.RecoveryActionCreateInput["policyDecision"],
        policyReasons: asJson({ expiresAt: input.expiresAt?.toISOString() ?? null, riskLevel: input.riskLevel }),
        policyVersion: input.policyVersion,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    });
    return toRecord(r as unknown as ActionRow);
  }

  async updateAction(ctx: ExecTenantContext, id: string, patch: ActionPatch): Promise<ActionRecord> {
    const data: Prisma.RecoveryActionUncheckedUpdateManyInput = { updatedAt: patch.updatedAt ?? new Date() };
    if (patch.state !== undefined) data.status = STATE_TO_PRISMA[patch.state] as Prisma.RecoveryActionUncheckedUpdateManyInput["status"];
    if (patch.approvedByUserId !== undefined) data.approvedByUserId = patch.approvedByUserId;
    if (patch.approvedAt !== undefined) data.approvedAt = patch.approvedAt;
    if (patch.executedAt !== undefined) data.executedAt = patch.executedAt;
    if (patch.completedAt !== undefined) data.completedAt = patch.completedAt;
    if (patch.externalReference !== undefined) data.externalReference = patch.externalReference;
    if (patch.failureReason !== undefined) data.failureReason = patch.failureReason;
    await prisma.recoveryAction.updateMany({ where: { id, tenantId: ctx.tenantId }, data });
    const r = await prisma.recoveryAction.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!r) throw new Error(`Action ${id} vanished after update.`);
    return toRecord(r as unknown as ActionRow);
  }

  async getCase(ctx: ExecTenantContext, caseId: string): Promise<ExecCaseRecord | null> {
    const c = await prisma.recoveryCase.findFirst({
      where: { id: caseId, tenantId: ctx.tenantId },
      select: { id: true, tenantId: true, status: true, amountAtRiskMinor: true, currency: true, resolvedAt: true },
    });
    return c ?? null;
  }

  async updateCase(ctx: ExecTenantContext, caseId: string, patch: ExecCasePatch): Promise<void> {
    const data: Prisma.RecoveryCaseUpdateManyMutationInput = {};
    if (patch.status !== undefined) data.status = patch.status as Prisma.RecoveryCaseUpdateManyMutationInput["status"];
    if (patch.resolvedAt !== undefined) data.resolvedAt = patch.resolvedAt;
    await prisma.recoveryCase.updateMany({ where: { id: caseId, tenantId: ctx.tenantId }, data });
  }

  async appendAudit(ctx: ExecTenantContext, entry: ExecAuditEntry): Promise<void> {
    await prisma.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorType: entry.actorType,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        metadata: asJson(entry.metadata),
      },
    });
  }
}

/** Prisma-backed case source: persisted recovery cases → PipelineCase[]. */
export class PrismaRecoveryCaseSource implements RecoveryCaseSource {
  async listCases(ctx: ExecTenantContext): Promise<PipelineCase[]> {
    const [rows, policy] = await Promise.all([
      prisma.recoveryCase.findMany({
        where: { tenantId: ctx.tenantId },
        include: { payment: { include: { paymentEvents: true } }, customer: true },
        orderBy: { openedAt: "asc" },
      }),
      prisma.policy.findFirst({
        where: { tenantId: ctx.tenantId, isActive: true },
        orderBy: { version: "desc" },
        select: { version: true, limits: true },
      }),
    ]);

    const policyRef = policy ? { version: policy.version, limits: policy.limits as PolicyLimits } : null;

    return rows.map((c) => {
      const failed = (c.payment?.paymentEvents ?? []).filter(
        (e) => e.type === "PAYMENT_FAILED" || e.type === "SUBSCRIPTION_FAILED",
      );
      const retryCount = failed.length;
      const hasExpiredLink = (c.payment?.paymentEvents ?? []).some((e) => e.type === "PAYMENT_LINK_EXPIRED");
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

      const paymentStatus = c.payment?.status ?? null;
      const alreadyRecovered = ["CAPTURED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(paymentStatus ?? "");

      const strategyContext: RecoveryStrategyContext = {
        caseId: c.id,
        tenantId: c.tenantId,
        caseStatus: c.status as RecoveryStrategyContext["caseStatus"],
        paymentStatus: paymentStatus as RecoveryStrategyContext["paymentStatus"],
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
        policyState: "OK",
        signals,
      };

      return {
        strategyContext,
        policyCase: {
          id: c.id,
          tenantId: c.tenantId,
          status: c.status,
          rootCause: c.rootCause,
          severity: c.severity,
          amountAtRiskMinor: c.amountAtRiskMinor,
          currency: c.currency,
          retryCount,
          openedAt: c.openedAt,
          expiresAt: null,
        },
        paymentContext: { paymentStatus, alreadyRecovered, usedIdempotencyKeys: [] },
        policy: policyRef,
      } satisfies PipelineCase;
    });
  }
}
