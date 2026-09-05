/**
 * RecoveryStrategyService — orchestrates strategy generation for a case:
 *   1) ask the configured provider for a plan,
 *   2) VALIDATE it against the strict RecoveryPlan schema (a malformed plan must
 *      never reach the execution/authorization layer), and
 *   3) emit the appropriate append-only audit event.
 *
 * This is the single choke point between "a provider proposed something" and
 * "the rest of the system may consider it". It executes nothing financial,
 * sends no messages, and calls no external model — it only produces, validates,
 * and records a recommendation.
 */
import type { Logger } from "@recoveros/observability";
import type { AuditTenantContext, StrategyAuditSink } from "./audit";
import type { RecoveryStrategyContext, RecoveryStrategyProvider } from "./provider";
import {
  RecoveryPlanValidationError,
  validateRecoveryPlan,
  type RecoveryPlan,
} from "./types";

export interface RecoveryStrategyServiceDeps {
  provider: RecoveryStrategyProvider;
  audit: StrategyAuditSink;
  logger?: Logger;
}

export class RecoveryStrategyService {
  private readonly provider: RecoveryStrategyProvider;
  private readonly audit: StrategyAuditSink;
  private readonly logger?: Logger;

  constructor(deps: RecoveryStrategyServiceDeps) {
    this.provider = deps.provider;
    this.audit = deps.audit;
    this.logger = deps.logger;
  }

  private assertTenant(ctx: RecoveryStrategyContext): void {
    if (!ctx || typeof ctx.tenantId !== "string" || ctx.tenantId.trim() === "") {
      throw new Error("Tenant context is required to generate a recovery strategy.");
    }
    if (typeof ctx.caseId !== "string" || ctx.caseId.trim() === "") {
      throw new Error("caseId is required to generate a recovery strategy.");
    }
  }

  /**
   * Generate, validate and audit a recovery plan for one case.
   *
   * On success returns the validated plan and emits `recovery.strategy.generated`
   * (plus `recovery.strategy.changed` when the strategy differs from
   * `ctx.previousStrategy`). On a malformed plan it emits
   * `recovery.strategy.rejected` and throws {@link RecoveryPlanValidationError};
   * the invalid plan is never returned.
   */
  async generate(ctx: RecoveryStrategyContext): Promise<RecoveryPlan> {
    this.assertTenant(ctx);
    const tenantScope: AuditTenantContext = { tenantId: ctx.tenantId };

    const candidate = await this.provider.generatePlan(ctx);
    const result = validateRecoveryPlan(candidate);

    if (!result.valid) {
      // Reject: record why, then refuse to let it proceed.
      await this.audit.append(tenantScope, {
        actorType: "SYSTEM",
        action: "recovery.strategy.rejected",
        entityType: "RecoveryCase",
        entityId: ctx.caseId,
        summary: `Rejected an invalid recovery plan from ${this.provider.name}.`,
        metadata: {
          provider: this.provider.name,
          proposedStrategy:
            typeof (candidate as { strategy?: unknown })?.strategy === "string"
              ? (candidate as { strategy: string }).strategy
              : null,
          issues: result.issues,
        },
      });
      this.logger?.warn("strategy.rejected", {
        tenantId: ctx.tenantId,
        caseId: ctx.caseId,
        provider: this.provider.name,
        issueCount: result.issues.length,
      });
      throw new RecoveryPlanValidationError(result.issues);
    }

    const plan = result.plan;

    // Change detection: the caller supplies the previously chosen strategy.
    const previous = ctx.previousStrategy ?? null;
    if (previous && previous !== plan.strategy) {
      await this.audit.append(tenantScope, {
        actorType: "SYSTEM",
        action: "recovery.strategy.changed",
        entityType: "RecoveryCase",
        entityId: ctx.caseId,
        summary: `Recovery strategy changed ${previous} → ${plan.strategy}.`,
        metadata: {
          provider: this.provider.name,
          from: previous,
          to: plan.strategy,
          ruleId: plan.modelMetadata.ruleId ?? null,
        },
      });
    }

    await this.audit.append(tenantScope, {
      actorType: "SYSTEM",
      action: "recovery.strategy.generated",
      entityType: "RecoveryCase",
      entityId: ctx.caseId,
      summary: `Generated ${plan.strategy} plan (confidence ${plan.confidence}).`,
      metadata: {
        provider: this.provider.name,
        strategy: plan.strategy,
        ruleId: plan.modelMetadata.ruleId ?? null,
        confidence: plan.confidence,
        riskLevel: plan.riskLevel,
        actionCount: plan.proposedActions.length,
        requiredCapabilities: plan.proposedActions.map((a) => a.requiredCapability),
        version: plan.modelMetadata.version,
      },
    });

    this.logger?.info("strategy.generated", {
      tenantId: ctx.tenantId,
      caseId: ctx.caseId,
      strategy: plan.strategy,
      ruleId: plan.modelMetadata.ruleId,
      actionCount: plan.proposedActions.length,
    });

    return plan;
  }
}
