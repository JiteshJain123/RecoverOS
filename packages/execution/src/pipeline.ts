/**
 * BatchRecoveryEvaluator — runs the full pipeline over a set of recovery cases:
 *
 *   detection (already persisted) → strategy → policy → simulated execution
 *
 * It does NOT cherry-pick: it processes every case from the source in order and
 * returns aggregate metrics. It is idempotent — re-running over the same source
 * creates no duplicate actions and yields identical metrics (execution is guarded
 * by idempotency keys and terminal-state checks). Nothing real is ever executed;
 * the executor uses a simulated provider.
 */
import type { Logger } from "@recoveros/observability";
import {
  PolicyEvaluator,
  type PolicyCaseView,
  type PolicyLimits,
  type PolicyPaymentContext,
} from "@recoveros/policy";
import {
  DeterministicRecoveryStrategyProvider,
  validateRecoveryPlan,
  type RecoveryStrategyContext,
} from "@recoveros/strategy";
import type { Clock, RecoveryActionExecutor } from "./executor";
import type { ExecTenantContext } from "./store";

/** One unit of work: everything needed to run a case through the pipeline. */
export interface PipelineCase {
  strategyContext: RecoveryStrategyContext;
  policyCase: PolicyCaseView;
  paymentContext: PolicyPaymentContext;
  policy: { version: number | null; limits: PolicyLimits | null } | null;
  /** Optional deterministic simulation override (e.g. "timeout"). */
  simScenario?: string;
}

/** Source of cases for the batch. Tenant-scoped. */
export interface RecoveryCaseSource {
  listCases(ctx: ExecTenantContext): Promise<PipelineCase[]>;
}

/** Simple in-memory source (tests + runnable script). */
export class InMemoryCaseSource implements RecoveryCaseSource {
  constructor(private readonly casesByTenant: Record<string, PipelineCase[]>) {}
  async listCases(ctx: ExecTenantContext): Promise<PipelineCase[]> {
    return this.casesByTenant[ctx.tenantId] ?? [];
  }
}

export interface BatchMetrics {
  tenantId: string;
  casesProcessed: number;
  casesAllowed: number;
  casesReviewed: number;
  casesBlocked: number;
  actionsExecuted: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  recoveredRevenueMinor: number;
  revenueStillAtRiskMinor: number;
  /** recoveredRevenue / total-at-risk, rounded to 4 dp. */
  recoveryRate: number;
  errors: Array<{ caseId: string; message: string }>;
}

export interface BatchEvaluatorDeps {
  source: RecoveryCaseSource;
  executor: RecoveryActionExecutor;
  clock: Clock;
  logger?: Logger;
  /** Injectable strategy provider (defaults to the deterministic one). */
  strategyProvider?: DeterministicRecoveryStrategyProvider;
  policyEvaluator?: PolicyEvaluator;
}

export class BatchRecoveryEvaluator {
  private readonly source: RecoveryCaseSource;
  private readonly executor: RecoveryActionExecutor;
  private readonly clock: Clock;
  private readonly logger?: Logger;
  private readonly strategy: DeterministicRecoveryStrategyProvider;
  private readonly policy: PolicyEvaluator;

  constructor(deps: BatchEvaluatorDeps) {
    this.source = deps.source;
    this.executor = deps.executor;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.strategy = deps.strategyProvider ?? new DeterministicRecoveryStrategyProvider({ clock: deps.clock });
    this.policy = deps.policyEvaluator ?? new PolicyEvaluator();
  }

  async run(ctx: ExecTenantContext): Promise<BatchMetrics> {
    const cases = await this.source.listCases(ctx);
    const m: BatchMetrics = {
      tenantId: ctx.tenantId,
      casesProcessed: 0,
      casesAllowed: 0,
      casesReviewed: 0,
      casesBlocked: 0,
      actionsExecuted: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0,
      recoveredRevenueMinor: 0,
      revenueStillAtRiskMinor: 0,
      recoveryRate: 0,
      errors: [],
    };

    let totalAtRisk = 0;
    const now = this.clock.now();

    for (const pc of cases) {
      m.casesProcessed += 1;
      totalAtRisk += pc.policyCase.amountAtRiskMinor;
      const caseId = pc.policyCase.id;
      try {
        const plan = await this.strategy.generatePlan(pc.strategyContext);
        const validation = validateRecoveryPlan(plan);
        if (!validation.valid) {
          m.errors.push({ caseId, message: "invalid_plan" });
          continue;
        }

        const decision = this.policy.evaluate({
          tenant: { tenantId: ctx.tenantId },
          case: pc.policyCase,
          plan,
          policy: pc.policy,
          payment: pc.paymentContext,
          now,
        });

        if (decision.decision === "BLOCK") {
          m.casesBlocked += 1;
          await this.executor.authorize(ctx, { caseId, plan, decision }); // audit-only
          continue;
        }

        if (decision.decision === "REVIEW") {
          m.casesReviewed += 1;
          await this.executor.authorize(ctx, { caseId, plan, decision });
          continue;
        }

        // ALLOW
        m.casesAllowed += 1;
        if (plan.strategy === "NO_ACTION") continue;

        const auth = await this.executor.authorize(ctx, { caseId, plan, decision });
        const action = auth.action;
        if (!action) continue; // no_action

        const ex = await this.executor.execute(ctx, {
          actionId: action.id,
          currentPolicyVersion: pc.policy?.version ?? null,
          metadata: { rootCause: pc.strategyContext.rootCause, simScenario: pc.simScenario },
        });

        if (ex.executed || ex.alreadyFinal) {
          m.actionsExecuted += 1;
          if (ex.action.state === "SUCCEEDED" && ex.recoveredAmountMinor > 0) {
            m.successfulRecoveries += 1;
            m.recoveredRevenueMinor += ex.recoveredAmountMinor;
          } else {
            m.failedRecoveries += 1;
          }
        }
      } catch (err) {
        m.errors.push({ caseId, message: err instanceof Error ? err.message : "unknown_error" });
      }
    }

    m.revenueStillAtRiskMinor = Math.max(0, totalAtRisk - m.recoveredRevenueMinor);
    m.recoveryRate = totalAtRisk > 0 ? Math.round((m.recoveredRevenueMinor / totalAtRisk) * 10_000) / 10_000 : 0;

    this.logger?.info("batch.evaluation.completed", {
      tenantId: ctx.tenantId,
      casesProcessed: m.casesProcessed,
      recoveredRevenueMinor: m.recoveredRevenueMinor,
    });

    return m;
  }
}
