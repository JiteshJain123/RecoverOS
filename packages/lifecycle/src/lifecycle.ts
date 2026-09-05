/**
 * RecoveryLifecycle — the end-to-end wiring that connects payment intelligence,
 * strategy, policy, the action state machine, the selected execution provider
 * (SIMULATED or RAZORPAY_TEST), and webhook-driven outcome reconciliation.
 *
 *   strategy → policy → authorize → (approve) → execute (provider) → replay
 *   webhook → reconcile → verify outcome → recovered revenue → audit trail
 *
 * Gemini (or any strategy provider) only PROPOSES a plan; it never chooses the
 * provider and never executes. Execution happens only for an ALLOW (or approved
 * REVIEW) action that passes every safeguard. Revenue is credited only on proven
 * capture (immediate capture, or a verified `payment.captured` webhook).
 */
import {
  ApprovalService,
  RecoveryActionExecutor,
  type ActionRecord,
  type Clock,
  type ExecuteResult,
  type InMemoryExecutionStore,
  type PaymentRecoveryProvider,
  type RecoveryProviderRequest,
  type RecoveryProviderResult,
  type Role,
} from "@recoveros/execution";
import { PolicyEvaluator, type PolicyDecision } from "@recoveros/policy";
import {
  validateRecoveryPlan,
  type RecoveryPlan,
  type RecoveryStrategyContext,
} from "@recoveros/strategy";
import {
  InMemoryWebhookStore,
  StaticProviderAccountResolver,
  StaticWebhookSecretSource,
  WebhookProcessor,
} from "@recoveros/webhooks";
import type { PipelineCase } from "@recoveros/execution";
import type { Logger } from "@recoveros/observability";
import type { ExecutionProviderMode } from "./provider-mode";
import { LifecycleCaseReconciler } from "./reconciler";
import { authorizedWebhook, capturedWebhook, failedWebhook } from "./failure-harness";

export type FinalOutcome =
  | "RECOVERED"
  | "LINK_CREATED"
  | "FAILED"
  | "TIMEOUT"
  | "CAPABILITY_ERROR"
  | "BLOCKED"
  | "REVIEW_PENDING"
  | "NO_ACTION"
  | "STOPPED";

export interface LifecycleTrace {
  caseId: string;
  tenantId: string;
  providerMode: ExecutionProviderMode;
  strategy: { strategy: string; confidence: number; ruleId?: string };
  policyDecision: {
    decision: PolicyDecision["decision"];
    reason: string;
    violatedRules: string[];
    requiredApproval: boolean;
    policyVersion: number | null;
  };
  action: {
    id: string;
    actionType: string;
    state: string;
    idempotencyKey: string;
    providerReference: string | null;
  } | null;
  provider: { mode: ExecutionProviderMode; calls: number };
  webhookEvents: Array<{ eventType: string; result: string }>;
  finalOutcome: FinalOutcome;
  recoveredRevenueMinor: number;
  stopReason?: string;
  /** True when an idempotency guard prevented a duplicate execution/webhook. */
  duplicatePrevented: boolean;
  /** True when the provider failed (timeout / 5xx / capability error). */
  providerFailure: boolean;
  auditEvents: string[];
}

/** Counts provider.execute invocations without changing behavior. */
class CountingProvider implements PaymentRecoveryProvider {
  calls = 0;
  readonly name: string;
  constructor(private readonly inner: PaymentRecoveryProvider) {
    this.name = inner.name;
  }
  execute(req: RecoveryProviderRequest): Promise<RecoveryProviderResult> {
    this.calls += 1;
    return this.inner.execute(req);
  }
}

export interface RecoveryLifecycleDeps {
  tenantId: string;
  execStore: InMemoryExecutionStore;
  provider: PaymentRecoveryProvider;
  providerMode: ExecutionProviderMode;
  strategyProvider: { name: string; generatePlan(ctx: RecoveryStrategyContext): Promise<RecoveryPlan> };
  clock: Clock;
  webhookSecret: string;
  webhookAccountId: string;
  logger?: Logger;
  executorConfig?: { executionTtlMs?: number; approvalTtlMs?: number };
}

export interface RunCaseOptions {
  autoApprove?: boolean;
  approver?: { userId: string; role: Role };
  /** How to replay the customer's webhook after execution. */
  replayWebhook?: "captured" | "failed" | "duplicate" | "out_of_order" | "none";
  /** Deterministic simulator scenario (SIMULATED provider only). */
  simScenario?: string;
  currentPolicyVersion?: number | null;
  /** Assert the case still qualifies (defaults true). */
  caseQualifies?: boolean;
}

export class RecoveryLifecycle {
  private readonly tenantId: string;
  private readonly execStore: InMemoryExecutionStore;
  private readonly provider: CountingProvider;
  private readonly providerMode: ExecutionProviderMode;
  private readonly executor: RecoveryActionExecutor;
  private readonly approvals: ApprovalService;
  private readonly strategyProvider: RecoveryLifecycleDeps["strategyProvider"];
  private readonly policy = new PolicyEvaluator();
  private readonly clock: Clock;
  private readonly webhookStore: InMemoryWebhookStore;
  private readonly webhookProcessor: WebhookProcessor;
  private readonly reconciler: LifecycleCaseReconciler;
  private readonly paymentToCase = new Map<string, string>();
  private readonly webhookSecret: string;
  private readonly webhookAccountId: string;

  constructor(deps: RecoveryLifecycleDeps) {
    this.tenantId = deps.tenantId;
    this.execStore = deps.execStore;
    this.provider = new CountingProvider(deps.provider);
    this.providerMode = deps.providerMode;
    this.clock = deps.clock;
    this.strategyProvider = deps.strategyProvider;
    this.webhookSecret = deps.webhookSecret;
    this.webhookAccountId = deps.webhookAccountId;

    this.executor = new RecoveryActionExecutor({
      store: this.execStore,
      provider: this.provider,
      clock: this.clock,
      logger: deps.logger,
      config: deps.executorConfig,
    });
    this.approvals = new ApprovalService({ store: this.execStore, clock: this.clock, logger: deps.logger });

    this.webhookStore = new InMemoryWebhookStore();
    this.reconciler = new LifecycleCaseReconciler(this.execStore, this.paymentToCase, this.clock);
    this.webhookProcessor = new WebhookProcessor({
      store: this.webhookStore,
      resolver: new StaticProviderAccountResolver({ [this.webhookAccountId]: this.tenantId }),
      secret: new StaticWebhookSecretSource(this.webhookSecret),
      caseReconciler: this.reconciler,
      clock: this.clock,
    });
  }

  get providerCalls(): number {
    return this.provider.calls;
  }

  async runCase(pc: PipelineCase, opts: RunCaseOptions = {}): Promise<LifecycleTrace> {
    const ctx = { tenantId: this.tenantId };
    const caseId = pc.policyCase.id;
    this.paymentToCase.set(pc.strategyContext.paymentId ?? caseId, caseId);

    const execAuditStart = this.execStore.audits.length;
    const whAuditStart = this.webhookStore.audits.length;
    const callsStart = this.provider.calls;

    const plan = await this.strategyProvider.generatePlan(pc.strategyContext);
    const validation = validateRecoveryPlan(plan);
    const strategyInfo = { strategy: plan.strategy, confidence: plan.confidence, ruleId: plan.modelMetadata.ruleId };

    const baseTrace = (over: Partial<LifecycleTrace>): LifecycleTrace => ({
      caseId,
      tenantId: this.tenantId,
      providerMode: this.providerMode,
      strategy: strategyInfo,
      policyDecision: over.policyDecision ?? {
        decision: "BLOCK",
        reason: "invalid_plan",
        violatedRules: [],
        requiredApproval: false,
        policyVersion: pc.policy?.version ?? null,
      },
      action: over.action ?? null,
      provider: { mode: this.providerMode, calls: this.provider.calls - callsStart },
      webhookEvents: over.webhookEvents ?? [],
      finalOutcome: over.finalOutcome ?? "STOPPED",
      recoveredRevenueMinor: over.recoveredRevenueMinor ?? 0,
      stopReason: over.stopReason,
      duplicatePrevented: over.duplicatePrevented ?? false,
      providerFailure: over.providerFailure ?? false,
      auditEvents: [
        ...this.execStore.audits.slice(execAuditStart).map((a) => a.action),
        ...this.webhookStore.audits.slice(whAuditStart).map((a) => a.action),
      ],
    });

    if (!validation.valid) {
      return baseTrace({ finalOutcome: "STOPPED", stopReason: "invalid_plan" });
    }

    const decision = this.policy.evaluate({
      tenant: ctx,
      case: pc.policyCase,
      plan,
      policy: pc.policy,
      payment: pc.paymentContext,
      now: this.clock.now(),
    });
    const decisionInfo = {
      decision: decision.decision,
      reason: decision.reason,
      violatedRules: decision.violatedRules,
      requiredApproval: decision.requiredApproval,
      policyVersion: decision.policyVersion,
    };

    // BLOCK → nothing executes; zero provider calls.
    if (decision.decision === "BLOCK") {
      await this.executor.authorize(ctx, { caseId, plan, decision });
      return baseTrace({ policyDecision: decisionInfo, finalOutcome: "BLOCKED" });
    }

    const auth = await this.executor.authorize(ctx, { caseId, plan, decision });
    if (!auth.action) {
      return baseTrace({ policyDecision: decisionInfo, finalOutcome: "NO_ACTION" });
    }

    // REVIEW → requires human approval before any execution/provider call.
    if (decision.decision === "REVIEW") {
      if (!opts.autoApprove) {
        return baseTrace({
          policyDecision: decisionInfo,
          action: this.actionView(auth.action),
          finalOutcome: "REVIEW_PENDING",
        });
      }
      await this.approvals.approve(ctx, auth.action.id, opts.approver ?? { userId: "dev-approver", role: "APPROVER" });
    }

    // Execute (safeguards enforced inside the executor).
    const ex = await this.executor.execute(ctx, {
      actionId: auth.action.id,
      currentPolicyVersion: opts.currentPolicyVersion ?? pc.policy?.version ?? null,
      caseQualifies: opts.caseQualifies,
      metadata: { rootCause: pc.strategyContext.rootCause, paymentRef: pc.strategyContext.paymentId, simScenario: opts.simScenario },
    });

    const authDuplicate = auth.status === "duplicate";

    if (!ex.executed) {
      // A safeguard blocked execution (expired / stale / policy changed / stopping)
      // or the action was already terminal (idempotent no-op on a repeat run).
      const action = await this.execStore.getAction(ctx, auth.action.id);
      const finalAction = action ?? auth.action;
      // Still allow a (duplicate-safe) webhook replay for the recovered-revenue read.
      const webhookEvents = ex.alreadyFinal ? await this.maybeReplayWebhook(pc, opts.replayWebhook ?? "none") : [];
      const recovered = finalAction.recoveredAmountMinor ?? 0;
      return baseTrace({
        policyDecision: decisionInfo,
        action: this.actionView(finalAction),
        webhookEvents,
        finalOutcome: ex.alreadyFinal && recovered > 0 ? "RECOVERED" : "STOPPED",
        stopReason: ex.reason,
        recoveredRevenueMinor: recovered,
        duplicatePrevented: authDuplicate || Boolean(ex.alreadyFinal),
      });
    }

    let finalOutcome = this.outcomeFromExecute(ex);
    const providerFailure = finalOutcome === "TIMEOUT" || finalOutcome === "FAILED" || finalOutcome === "CAPABILITY_ERROR";

    // Webhook replay realizes link-based recovery (and duplicate/out-of-order safety).
    const webhookEvents = await this.maybeReplayWebhook(pc, opts.replayWebhook ?? "none");
    const webhookDuplicate = webhookEvents.some((e) => e.result === "duplicate");

    // Re-read the (possibly credited) action to report recovered revenue.
    const finalAction = (await this.execStore.getAction(ctx, auth.action.id)) ?? auth.action;
    const recovered = finalAction.recoveredAmountMinor ?? 0;
    if (recovered > 0) finalOutcome = "RECOVERED";

    return baseTrace({
      policyDecision: decisionInfo,
      action: this.actionView(finalAction),
      webhookEvents,
      finalOutcome,
      recoveredRevenueMinor: recovered,
      duplicatePrevented: authDuplicate || webhookDuplicate,
      providerFailure,
    });
  }

  private outcomeFromExecute(ex: ExecuteResult): FinalOutcome {
    const o = ex.outcome?.outcome;
    if (o === "SUCCEEDED") return "RECOVERED";
    if (o === "LINK_CREATED") return "LINK_CREATED";
    if (o === "TIMEOUT") return "TIMEOUT";
    if (o === "FAILED") {
      return ex.outcome?.detail?.startsWith("capability") || ex.outcome?.detail?.startsWith("razorpay_")
        ? "CAPABILITY_ERROR"
        : "FAILED";
    }
    return "FAILED";
  }

  private async maybeReplayWebhook(
    pc: PipelineCase,
    mode: NonNullable<RunCaseOptions["replayWebhook"]>,
  ): Promise<Array<{ eventType: string; result: string }>> {
    if (mode === "none") return [];
    const paymentId = pc.strategyContext.paymentId ?? pc.policyCase.id;
    const amountMinor = pc.policyCase.amountAtRiskMinor;
    const events: Array<{ eventType: string; result: string }> = [];

    const push = async (fixture: { rawBody: string; signature: string; eventId: string }, eventType: string) => {
      const res = await this.webhookProcessor.process({
        rawBody: fixture.rawBody,
        signature: fixture.signature,
        eventId: fixture.eventId,
      });
      events.push({ eventType, result: res.status });
    };

    const captured = capturedWebhook({ secret: this.webhookSecret, accountId: this.webhookAccountId, paymentId, amountMinor });

    if (mode === "captured") {
      await push(captured, "payment.captured");
    } else if (mode === "failed") {
      await push(failedWebhook({ secret: this.webhookSecret, accountId: this.webhookAccountId, paymentId, amountMinor }), "payment.failed");
    } else if (mode === "duplicate") {
      await push(captured, "payment.captured");
      await push(captured, "payment.captured"); // duplicate delivery — must not double-credit
    } else if (mode === "out_of_order") {
      // Captured first, then a LATE authorized — must not downgrade or re-credit.
      const authorized = authorizedWebhook({ secret: this.webhookSecret, accountId: this.webhookAccountId, paymentId, amountMinor });
      await push(captured, "payment.captured");
      await push(authorized, "payment.authorized");
    }
    return events;
  }

  private actionView(a: ActionRecord): NonNullable<LifecycleTrace["action"]> {
    return {
      id: a.id,
      actionType: a.actionType,
      state: a.state,
      idempotencyKey: a.idempotencyKey,
      providerReference: a.externalReference,
    };
  }
}
