/**
 * RecoveryActionExecutor — the safe execution layer.
 *
 * It turns an authorized RecoveryPlan into a lifecycle-managed RecoveryAction and
 * (only when every safeguard passes) runs it through a PaymentRecoveryProvider,
 * then verifies and records the outcome. It NEVER moves real money (the provider
 * does, and in this phase the provider is a simulator).
 *
 * Enforced invariants:
 *  - Gemini/strategy cannot bypass this layer: execution requires an ALLOW
 *    policy decision (or a human-approved REVIEW) recorded on the action.
 *  - Every executable action carries an idempotency key; a repeat authorize with
 *    the same key returns the existing action (no duplicates), and a repeat
 *    execute on a terminal action is a no-op (no double execution).
 *  - Recovery revenue is credited ONLY when the provider explicitly reports a
 *    SUCCEEDED outcome with a positive recovered amount.
 */
import type { Logger } from "@recoveros/observability";
import type { PolicyActionType, PolicyDecision } from "@recoveros/policy";
import type { RecoveryPlan } from "@recoveros/strategy";
import { ActionNotFoundError } from "./errors";
import type { PaymentRecoveryProvider, RecoveryProviderResult } from "./provider";
import { assertTransition, type ActionState } from "./state-machine";
import type { ActionPatch, ActionRecord, ExecAuditEntry, ExecTenantContext, ExecutionStore } from "./store";

export interface Clock {
  now(): Date;
}

export interface ExecutorConfig {
  /** How long after authorization an action may still execute. */
  executionTtlMs: number;
  /** How long a human approval remains fresh before it is stale. */
  approvalTtlMs: number;
}

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  executionTtlMs: 24 * 3600 * 1000,
  approvalTtlMs: 24 * 3600 * 1000,
};

export interface ExecutorDeps {
  store: ExecutionStore;
  provider: PaymentRecoveryProvider;
  clock: Clock;
  logger?: Logger;
  config?: Partial<ExecutorConfig>;
}

export interface AuthorizeInput {
  caseId: string;
  plan: RecoveryPlan;
  decision: PolicyDecision;
  decisionId?: string | null;
}

export type AuthorizeStatus =
  | "authorized"
  | "approval_required"
  | "blocked"
  | "no_action"
  | "duplicate";

export interface AuthorizeResult {
  status: AuthorizeStatus;
  action: ActionRecord | null;
}

export interface StoppingState {
  paymentRecovered?: boolean;
  attemptsExhausted?: boolean;
}

export interface ExecuteInput {
  actionId: string;
  /** Current active policy version; a mismatch after approval blocks execution. */
  currentPolicyVersion?: number | null;
  /** Caller assertion that the case still qualifies (false ⇒ blocked). */
  caseQualifies?: boolean;
  /** Evaluated stopping conditions; any true ⇒ do not execute. */
  stopping?: StoppingState;
  /** Deterministic drivers for the provider (rootCause, simScenario). */
  metadata?: Record<string, unknown>;
}

export interface ExecuteResult {
  executed: boolean;
  action: ActionRecord;
  outcome?: RecoveryProviderResult;
  recoveredAmountMinor: number;
  reason?: string;
  alreadyFinal?: boolean;
}

/** RecoveryPlan actionKind → the bounded policy/execution action type. */
const ACTION_KIND_TO_TYPE: Record<string, PolicyActionType> = {
  RETRY_PAYMENT: "RETRY_PAYMENT",
  CREATE_PAYMENT_LINK: "SEND_PAYMENT_LINK",
  SEND_CUSTOMER_MESSAGE: "CONTACT_CUSTOMER",
};

const RECOVERED_CASE_STATUSES: ReadonlySet<string> = new Set([
  "CAPTURED",
  "RECOVERED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);
const STOPPED_CASE_STATUSES: ReadonlySet<string> = new Set([
  "REJECTED",
  "EXPIRED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
]);

export class RecoveryActionExecutor {
  private readonly store: ExecutionStore;
  private readonly provider: PaymentRecoveryProvider;
  private readonly clock: Clock;
  private readonly logger?: Logger;
  private readonly config: ExecutorConfig;

  constructor(deps: ExecutorDeps) {
    this.store = deps.store;
    this.provider = deps.provider;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...deps.config };
  }

  private async audit(ctx: ExecTenantContext, entry: ExecAuditEntry): Promise<void> {
    await this.store.appendAudit(ctx, entry);
  }

  private async transition(
    ctx: ExecTenantContext,
    action: ActionRecord,
    to: ActionState,
    extra: ActionPatch = {},
  ): Promise<ActionRecord> {
    assertTransition(action.state, to);
    return this.store.updateAction(ctx, action.id, { state: to, updatedAt: this.clock.now(), ...extra });
  }

  /** Pick the primary executable action from a plan (or a review task). */
  private pickExecutable(
    plan: RecoveryPlan,
  ): { key: string; actionType: PolicyActionType; amountMinor: number | null; currency: string; executable: boolean } | null {
    const exec = plan.proposedActions.find((a) => ACTION_KIND_TO_TYPE[a.actionKind]);
    if (exec) {
      return {
        key: exec.idempotencyKey,
        actionType: ACTION_KIND_TO_TYPE[exec.actionKind] as PolicyActionType,
        amountMinor: exec.amountMinor ?? null,
        currency: exec.currency ?? "INR",
        executable: true,
      };
    }
    const flag = plan.proposedActions.find((a) => a.actionKind === "FLAG_FOR_HUMAN_REVIEW");
    if (flag) {
      return { key: flag.idempotencyKey, actionType: "NO_ACTION", amountMinor: null, currency: "INR", executable: false };
    }
    return null;
  }

  /**
   * Turn a policy decision into a lifecycle-managed action.
   * BLOCK → nothing created; ALLOW → APPROVED; REVIEW → APPROVAL_REQUIRED.
   */
  async authorize(ctx: ExecTenantContext, input: AuthorizeInput): Promise<AuthorizeResult> {
    const now = this.clock.now();
    const { plan, decision, caseId } = input;

    if (decision.decision === "BLOCK") {
      await this.audit(ctx, {
        actorType: "POLICY_ENGINE",
        action: "recovery.action.blocked",
        entityType: "RecoveryCase",
        entityId: caseId,
        summary: `Policy blocked recovery: ${decision.reason}`,
        metadata: {
          decision: "BLOCK",
          violatedRules: decision.violatedRules,
          policyVersion: decision.policyVersion,
          at: now.toISOString(),
        },
      });
      return { status: "blocked", action: null };
    }

    const pick = this.pickExecutable(plan);
    if (plan.strategy === "NO_ACTION" || !pick) {
      return { status: "no_action", action: null };
    }

    // Idempotency: never create a duplicate action for the same key.
    const existing = await this.store.findActionByIdempotencyKey(ctx, pick.key);
    if (existing) return { status: "duplicate", action: existing };

    const created = await this.store.createAction(ctx, {
      caseId,
      decisionId: input.decisionId ?? null,
      idempotencyKey: pick.key,
      actionType: pick.actionType,
      amountMinor: pick.amountMinor,
      currency: pick.currency,
      state: "PROPOSED",
      policyDecision: decision.decision,
      policyVersion: decision.policyVersion,
      riskLevel: plan.riskLevel,
      expiresAt: new Date(now.getTime() + this.config.executionTtlMs),
      createdAt: now,
    });
    await this.audit(ctx, {
      actorType: "SYSTEM",
      action: "recovery.action.proposed",
      entityType: "RecoveryAction",
      entityId: created.id,
      summary: `Proposed ${created.actionType} (${decision.decision}).`,
      metadata: { decision: decision.decision, policyVersion: decision.policyVersion, at: now.toISOString() },
    });

    if (decision.decision === "ALLOW") {
      const approved = await this.transition(ctx, created, "APPROVED");
      await this.audit(ctx, {
        actorType: "POLICY_ENGINE",
        action: "recovery.action.approved",
        entityType: "RecoveryAction",
        entityId: approved.id,
        summary: "Auto-approved by policy (ALLOW).",
        metadata: { decision: "ALLOW", policyVersion: decision.policyVersion, at: now.toISOString() },
      });
      return { status: "authorized", action: approved };
    }

    const review = await this.transition(ctx, created, "APPROVAL_REQUIRED");
    await this.audit(ctx, {
      actorType: "POLICY_ENGINE",
      action: "recovery.action.approval_required",
      entityType: "RecoveryAction",
      entityId: review.id,
      summary: `Human approval required: ${decision.reason}`,
      metadata: {
        decision: "REVIEW",
        violatedRules: decision.violatedRules,
        policyVersion: decision.policyVersion,
        at: now.toISOString(),
      },
    });
    return { status: "approval_required", action: review };
  }

  /** Execute an authorized action through the provider, with all safeguards. */
  async execute(ctx: ExecTenantContext, input: ExecuteInput): Promise<ExecuteResult> {
    const now = this.clock.now();
    const found = await this.store.getAction(ctx, input.actionId);
    if (!found) throw new ActionNotFoundError(input.actionId);
    let action: ActionRecord = found;

    // Duplicate-execution guard (idempotent): terminal/in-flight → no re-run.
    if (action.state === "SUCCEEDED") {
      return {
        executed: false,
        alreadyFinal: true,
        action,
        recoveredAmountMinor: action.recoveredAmountMinor ?? 0,
        reason: "already_executed",
      };
    }
    if (action.state === "FAILED") {
      return { executed: false, alreadyFinal: true, action, recoveredAmountMinor: 0, reason: "already_executed" };
    }
    if (action.state === "EXECUTING") {
      return { executed: false, action, recoveredAmountMinor: 0, reason: "execution_in_progress" };
    }

    const safeguardFail = async (reason: string, terminal?: ActionState): Promise<ExecuteResult> => {
      if (terminal) {
        action = await this.transition(ctx, action, terminal, { failureReason: reason, completedAt: now });
      }
      await this.audit(ctx, {
        actorType: "SYSTEM",
        action: "recovery.action.safeguard_blocked",
        entityType: "RecoveryAction",
        entityId: action.id,
        summary: `Execution blocked: ${reason}`,
        metadata: {
          reason,
          state: action.state,
          policyVersion: action.policyVersion,
          at: now.toISOString(),
        },
      });
      return { executed: false, action, recoveredAmountMinor: 0, reason };
    };

    if (action.actionType === "NO_ACTION") return safeguardFail("nothing_to_execute");
    if (action.state !== "APPROVED") return safeguardFail("not_approved");

    // Authorized = policy ALLOW, or a human approved a REVIEW.
    const authorized = action.policyDecision === "ALLOW" || action.approvedByUserId !== null;
    if (!authorized) return safeguardFail("not_authorized");

    if (action.expiresAt && now.getTime() > action.expiresAt.getTime()) {
      return safeguardFail("expired", "EXPIRED");
    }
    if (action.approvedAt && now.getTime() - action.approvedAt.getTime() > this.config.approvalTtlMs) {
      return safeguardFail("stale_approval", "EXPIRED");
    }
    if (
      input.currentPolicyVersion !== undefined &&
      action.policyVersion !== null &&
      input.currentPolicyVersion !== action.policyVersion
    ) {
      return safeguardFail("policy_changed", "CANCELLED");
    }

    const c = await this.store.getCase(ctx, action.caseId);
    if (!c) return safeguardFail("case_missing", "CANCELLED");
    if (RECOVERED_CASE_STATUSES.has(c.status)) return safeguardFail("already_recovered", "CANCELLED");
    if (STOPPED_CASE_STATUSES.has(c.status) || input.caseQualifies === false) {
      return safeguardFail("case_no_longer_qualifies", "CANCELLED");
    }
    if (input.stopping?.paymentRecovered) return safeguardFail("stopping_condition:payment_recovered", "CANCELLED");
    if (input.stopping?.attemptsExhausted) return safeguardFail("stopping_condition:attempts_exhausted", "CANCELLED");

    // All safeguards passed → execute.
    action = await this.transition(ctx, action, "EXECUTING", { executedAt: now });
    await this.audit(ctx, {
      actorType: "SYSTEM",
      action: "recovery.action.executing",
      entityType: "RecoveryAction",
      entityId: action.id,
      summary: `Executing ${action.actionType} via ${this.provider.name}.`,
      metadata: { policyVersion: action.policyVersion, at: now.toISOString() },
    });

    const result = await this.provider.execute({
      actionType: action.actionType as Exclude<PolicyActionType, "NO_ACTION">,
      idempotencyKey: action.idempotencyKey,
      amountMinor: action.amountMinor ?? undefined,
      currency: action.currency,
      // Always inject the tenant context so a real provider can resolve
      // tenant-scoped credentials; callers cannot override it.
      metadata: { ...(input.metadata ?? {}), tenantId: ctx.tenantId },
    });

    const completedAt = this.clock.now();
    const isSuccessState = result.outcome === "SUCCEEDED" || result.outcome === "LINK_CREATED";
    const finalState: ActionState = isSuccessState ? "SUCCEEDED" : "FAILED";
    // Recovery revenue ONLY on a genuine SUCCEEDED outcome with a positive amount.
    const recovered = result.outcome === "SUCCEEDED" ? Math.max(0, result.recoveredAmountMinor) : 0;

    action = await this.transition(ctx, action, finalState, {
      completedAt,
      externalReference: result.externalReference,
      failureReason: finalState === "FAILED" ? `${result.outcome}: ${result.detail}` : null,
      recoveredAmountMinor: recovered,
    });

    if (recovered > 0) {
      await this.store.updateCase(ctx, action.caseId, { status: "RECOVERED", resolvedAt: completedAt });
    }

    await this.audit(ctx, {
      actorType: "SYSTEM",
      action: finalState === "SUCCEEDED" ? "recovery.action.succeeded" : "recovery.action.failed",
      entityType: "RecoveryAction",
      entityId: action.id,
      summary: `Action ${finalState} (${result.outcome}); recovered ${recovered}.`,
      metadata: {
        outcome: result.outcome,
        recoveredAmountMinor: recovered,
        externalReference: result.externalReference,
        policyVersion: action.policyVersion,
        failureReason: action.failureReason,
        at: completedAt.toISOString(),
      },
    });

    this.logger?.info("recovery.action.executed", {
      tenantId: ctx.tenantId,
      actionId: action.id,
      outcome: result.outcome,
      recoveredAmountMinor: recovered,
    });

    return { executed: true, action, outcome: result, recoveredAmountMinor: recovered };
  }
}
