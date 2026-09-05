/**
 * GeminiRecoveryService — orchestrates a single advisory Gemini recommendation
 * for an existing recovery case and records the full agent trace.
 *
 * Order of operations (nothing financial is ever executed):
 *   1. load the case context, tenant-scoped (foreign/missing → CaseNotFoundError);
 *   2. create an AgentRun (RUNNING);
 *   3. call Gemini via the provider (structured output + validation happen there);
 *   4. record an AgentToolCall with structured input/output metadata (no secrets);
 *   5. complete the AgentRun (SUCCEEDED / TIMEOUT / INVALID_OUTPUT / FAILED);
 *   6. on success, upsert a RecoveryDecision and write an audit event;
 *   7. return the structured decision. The proposed action is NOT executed.
 */
import type { Logger } from "@recoveros/observability";
import type { RecoveryPlan, Strategy } from "@recoveros/strategy";
import { GeminiError } from "./errors";
import type { GeminiCallMeta, GeminiRecoveryStrategyProvider } from "./provider";
import type {
  AgentRunStatus,
  DecisionActionType,
  GeminiRecoveryStore,
  TenantContext,
} from "./store";

/** Thrown when the case does not exist within the tenant scope (→ HTTP 404). */
export class CaseNotFoundError extends Error {
  constructor(public readonly caseId: string) {
    super(`Recovery case ${caseId} not found for tenant.`);
    this.name = "CaseNotFoundError";
  }
}

export interface GeminiRecoveryServiceDeps {
  provider: GeminiRecoveryStrategyProvider;
  store: GeminiRecoveryStore;
  logger?: Logger;
  now?: () => Date;
}

export interface RecommendationResult {
  agentRunId: string;
  decisionId: string;
  plan: RecoveryPlan;
  meta: GeminiCallMeta;
}

/** Strategy → RecoveryDecision.proposedAction (bounded Prisma enum). */
function toDecisionAction(strategy: Strategy): DecisionActionType {
  switch (strategy) {
    case "RETRY_PAYMENT":
      return "RETRY_PAYMENT";
    case "SEND_PAYMENT_LINK":
    case "CHECKOUT_RECOVERY":
      return "SEND_PAYMENT_LINK";
    case "CUSTOMER_REMINDER":
      return "CONTACT_CUSTOMER";
    case "NO_ACTION":
    case "HUMAN_REVIEW":
    default:
      return "NO_ACTION";
  }
}

/** Map a failure to the AgentRun status recorded for it. */
function statusForError(err: unknown): AgentRunStatus {
  if (err instanceof GeminiError) {
    if (err.category === "timeout") return "TIMEOUT";
    if (err.category === "malformed") return "INVALID_OUTPUT";
    return "FAILED";
  }
  return "FAILED";
}

/** Concise, non-secret error label for the AgentRun/AgentToolCall. */
function errorLabel(err: unknown): string {
  if (err instanceof GeminiError) return `${err.category}: ${err.message}`;
  return err instanceof Error ? err.message : "unknown_error";
}

export class GeminiRecoveryService {
  private readonly provider: GeminiRecoveryStrategyProvider;
  private readonly store: GeminiRecoveryStore;
  private readonly logger?: Logger;
  private readonly now: () => Date;

  constructor(deps: GeminiRecoveryServiceDeps) {
    this.provider = deps.provider;
    this.store = deps.store;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
  }

  private assertTenant(ctx: TenantContext, caseId: string): void {
    if (!ctx || typeof ctx.tenantId !== "string" || ctx.tenantId.trim() === "") {
      throw new Error("Tenant context is required.");
    }
    if (typeof caseId !== "string" || caseId.trim() === "") {
      throw new Error("caseId is required.");
    }
  }

  async recommend(ctx: TenantContext, caseId: string): Promise<RecommendationResult> {
    this.assertTenant(ctx, caseId);

    // 1) Tenant-scoped load. A foreign/missing case is indistinguishable.
    const loaded = await this.store.loadCaseContext(ctx, caseId);
    if (!loaded) throw new CaseNotFoundError(caseId);

    const model = this.provider.modelId;
    const startedAt = this.now();

    // 2) AgentRun (RUNNING).
    const run = await this.store.createAgentRun(ctx, {
      caseId,
      provider: this.provider.name,
      model,
      startedAt,
    });

    // Structured input metadata for the tool call — NO secrets, NO raw PII.
    const sctx = loaded.strategyContext;
    const inputMeta: Record<string, unknown> = {
      provider: this.provider.name,
      model,
      caseId,
      rootCause: sctx.rootCause,
      severity: sctx.severity,
      amountAtRiskMinor: sctx.amountAtRiskMinor,
      currency: sctx.currency,
      retryCount: sctx.retryCount,
      signalCount: sctx.signals.length,
    };

    try {
      // 3) Gemini call (structured output + validation inside the provider).
      const rec = await this.provider.recommend({
        ctx: sctx,
        customerHistory: loaded.customerHistory,
        policyConstraints: loaded.policyConstraints,
      });
      const completedAt = this.now();
      const latencyMs = rec.meta.latencyMs || Math.max(0, completedAt.getTime() - startedAt.getTime());

      // 4) AgentToolCall (success) with structured input/output metadata.
      await this.store.recordToolCall(ctx, {
        agentRunId: run.id,
        sequence: 1,
        name: "gemini.generateContent",
        args: inputMeta,
        result: {
          strategy: rec.plan.strategy,
          confidence: rec.plan.confidence,
          riskLevel: rec.plan.riskLevel,
          requestId: rec.meta.requestId ?? null,
          attempts: rec.meta.attempts,
          coercedToHumanReview: rec.meta.coercedToHumanReview,
          actionKinds: rec.plan.proposedActions.map((a) => a.actionKind),
        },
        isError: false,
      });

      // 5) AgentRun (SUCCEEDED).
      await this.store.completeAgentRun(ctx, run.id, {
        status: "SUCCEEDED",
        latencyMs,
        inputTokens: rec.meta.inputTokens,
        outputTokens: rec.meta.outputTokens,
        completedAt,
      });

      // 6) RecoveryDecision (advisory) + audit event. NOT executed.
      const actionable = rec.plan.strategy !== "NO_ACTION" && rec.plan.strategy !== "HUMAN_REVIEW";
      const decision = await this.store.upsertDecision(ctx, {
        caseId,
        agentRunId: run.id,
        proposedAction: toDecisionAction(rec.plan.strategy),
        amountMinor: actionable ? sctx.amountAtRiskMinor : null,
        confidence: rec.plan.confidence,
        diagnosis: `${sctx.rootCause ?? "UNKNOWN"} / ${rec.plan.strategy}`,
        rationale: rec.plan.rationale,
      });

      await this.store.appendAudit(ctx, {
        actorType: "AGENT",
        action: "recovery.strategy.gemini.generated",
        entityType: "RecoveryCase",
        entityId: caseId,
        summary: `Gemini recommended ${rec.plan.strategy} (confidence ${rec.plan.confidence}).`,
        metadata: {
          provider: this.provider.name,
          model,
          agentRunId: run.id,
          decisionId: decision.id,
          strategy: rec.plan.strategy,
          confidence: rec.plan.confidence,
          riskLevel: rec.plan.riskLevel,
          coercedToHumanReview: rec.meta.coercedToHumanReview,
          evidenceRefs: rec.raw.evidenceRefs,
          requiredCapabilities: rec.plan.proposedActions.map((a) => a.requiredCapability),
        },
      });

      this.logger?.info("gemini.recommend.succeeded", {
        tenantId: ctx.tenantId,
        caseId,
        agentRunId: run.id,
        strategy: rec.plan.strategy,
      });

      return { agentRunId: run.id, decisionId: decision.id, plan: rec.plan, meta: rec.meta };
    } catch (err) {
      const completedAt = this.now();
      const latencyMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
      const status = statusForError(err);
      const label = errorLabel(err);

      // 4/5) Record the failed tool call + AgentRun status. No decision created.
      await this.store.recordToolCall(ctx, {
        agentRunId: run.id,
        sequence: 1,
        name: "gemini.generateContent",
        args: inputMeta,
        result: { errorCategory: err instanceof GeminiError ? err.category : "unknown" },
        isError: true,
      });
      await this.store.completeAgentRun(ctx, run.id, {
        status,
        latencyMs,
        error: label,
        completedAt,
      });
      await this.store.appendAudit(ctx, {
        actorType: "AGENT",
        action: "recovery.strategy.gemini.failed",
        entityType: "RecoveryCase",
        entityId: caseId,
        summary: `Gemini recommendation failed (${status}).`,
        metadata: {
          provider: this.provider.name,
          model,
          agentRunId: run.id,
          errorCategory: err instanceof GeminiError ? err.category : "unknown",
        },
      });

      this.logger?.warn("gemini.recommend.failed", {
        tenantId: ctx.tenantId,
        caseId,
        agentRunId: run.id,
        status,
      });
      throw err;
    }
  }
}
