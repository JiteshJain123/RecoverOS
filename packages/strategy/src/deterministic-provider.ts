/**
 * DeterministicRecoveryStrategyProvider — a pure, rule-based baseline that gives
 * RecoverOS a safe recovery strategy for every case WITHOUT any AI. It is not a
 * stand-in that "pretends" to be a model: its `modelMetadata.provider` is
 * `"deterministic"`, it exposes the exact rule that fired, and identical input
 * always yields an identical plan.
 *
 * It never executes anything. It returns a {@link RecoveryPlan} recommendation;
 * the policy engine authorizes and only later can an approved action reach a
 * provider adapter. Some strategies (e.g. SEND_PAYMENT_LINK, CUSTOMER_REMINDER)
 * may require capabilities a given PSP cannot fulfil — each action declares the
 * capability it needs and the plan makes no assumption that it is executable.
 *
 * Rule order (first match wins — most conclusive/safest checks first):
 *   0. already captured/recovered        → NO_ACTION
 *   1. policy-blocked / case BLOCKED      → NO_ACTION
 *   2. case terminal (REJECTED/EXPIRED/FAILED) → NO_ACTION
 *   3. unknown / unclassified root cause  → HUMAN_REVIEW
 *   4. CRITICAL severity (high value/risk) → HUMAN_REVIEW
 *   5. repeated BANK_DECLINE              → HUMAN_REVIEW (policy REVIEW) | NO_ACTION
 *   6. single BANK_DECLINE                → SEND_PAYMENT_LINK (alternate method)
 *   7. INSUFFICIENT_FUNDS                 → CUSTOMER_REMINDER (+ payment link)
 *   8. TIMEOUT / GATEWAY_ERROR (transient) → RETRY_PAYMENT (unless retry cap hit)
 *   9. abandonment / expired checkout     → CHECKOUT_RECOVERY
 *  10. fallback                           → HUMAN_REVIEW
 */
import { CAPABILITY, STRATEGY_RULES_VERSION, STRATEGY_THRESHOLDS, TTL_SECONDS } from "./config";
import { generateIdempotencyKey } from "./idempotency";
import type {
  PolicyState,
  RecoveryStrategyContext,
  RecoveryStrategyProvider,
} from "./provider";
import type {
  ActionKind,
  EvidenceItem,
  ExpectedOutcome,
  ProposedRecoveryAction,
  RecoveryPlan,
  RiskLevel,
  StoppingCondition,
  Strategy,
} from "./types";

/** Injectable clock so `generatedAt` is deterministic in tests. */
export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

/** Terminal case states that mean "do nothing further". */
const TERMINAL_STATUSES = new Set(["REJECTED", "EXPIRED", "FAILED"]);

// --- Small builders --------------------------------------------------------

function stop(type: StoppingCondition["type"], description: string, limit?: number): StoppingCondition {
  return limit === undefined ? { type, description } : { type, description, limit };
}

function evidence(label: string, detail: string, source: EvidenceItem["source"]): EvidenceItem {
  return { label, detail, source };
}

/** Evidence common to every plan: the case's intelligence annotations. */
function baseEvidence(ctx: RecoveryStrategyContext): EvidenceItem[] {
  const items: EvidenceItem[] = [
    evidence("rootCause", ctx.rootCause ?? "UNCLASSIFIED", "intelligence"),
    evidence("severity", ctx.severity ?? "UNKNOWN", "intelligence"),
    evidence(
      "amountAtRisk",
      `${ctx.amountAtRiskMinor} ${ctx.currency} (minor units)`,
      "intelligence",
    ),
    evidence("retryCount", String(ctx.retryCount), "payment"),
    evidence("policyState", ctx.policyState, "policy"),
  ];
  if (ctx.priorityScore !== null) {
    items.push(evidence("priorityScore", String(ctx.priorityScore), "intelligence"));
  }
  const primary = ctx.signals[0];
  if (primary) {
    items.push(evidence("primarySignal", `${primary.type}: ${primary.reason}`, "rule"));
  }
  return items;
}

interface ActionSpec {
  actionKind: ActionKind;
  purpose: string;
  requiredCapability: string;
  riskLevel: RiskLevel;
  stoppingCondition: StoppingCondition;
  withAmount?: boolean;
  ttlSeconds?: number;
}

function buildAction(ctx: RecoveryStrategyContext, spec: ActionSpec): ProposedRecoveryAction {
  const action: ProposedRecoveryAction = {
    actionKind: spec.actionKind,
    purpose: spec.purpose,
    requiredCapability: spec.requiredCapability,
    riskLevel: spec.riskLevel,
    idempotencyKey: generateIdempotencyKey({
      tenantId: ctx.tenantId,
      caseId: ctx.caseId,
      actionKind: spec.actionKind,
      rootCause: ctx.rootCause,
      amountMinor: ctx.amountAtRiskMinor,
      retryCount: ctx.retryCount,
    }),
    stoppingCondition: spec.stoppingCondition,
  };
  if (spec.withAmount) {
    action.amountMinor = ctx.amountAtRiskMinor;
    action.currency = ctx.currency;
  }
  if (spec.ttlSeconds !== undefined) action.ttlSeconds = spec.ttlSeconds;
  return action;
}

/** The rule-specific fields (everything except metadata/generatedAt). */
interface RuleDecision {
  ruleId: string;
  strategy: Strategy;
  rationale: string;
  confidence: number;
  riskLevel: RiskLevel;
  expectedOutcome: ExpectedOutcome;
  proposedActions: ProposedRecoveryAction[];
  stoppingConditions: StoppingCondition[];
  extraEvidence?: EvidenceItem[];
}

// --- The pure decision function -------------------------------------------

/**
 * Choose a strategy for a case. Pure and deterministic — exported so callers can
 * unit-test the decision independently of plan assembly.
 */
export function decideStrategy(ctx: RecoveryStrategyContext): RuleDecision {
  const { rootCause, severity, retryCount, amountAtRiskMinor } = ctx;
  const recovered = ctx.paymentStatus === "CAPTURED" || ctx.caseStatus === "RECOVERED";
  const repeated = retryCount >= STRATEGY_THRESHOLDS.repeatedFailureMinAttempts;

  // 0) Already recovered — nothing to do.
  if (recovered) {
    return {
      ruleId: "already_recovered",
      strategy: "NO_ACTION",
      rationale: "Payment is already captured/recovered; no recovery intervention is required.",
      confidence: 1,
      riskLevel: "LOW",
      expectedOutcome: {
        successProbability: 1,
        description: "Revenue already captured; nothing further at risk.",
        revenueRecoverableMinor: 0,
      },
      proposedActions: [],
      stoppingConditions: [stop("PAYMENT_RECOVERED", "Payment already captured.")],
    };
  }

  // 1) Policy blocked — the deterministic gate forbids automated recovery.
  if (ctx.policyState === "BLOCKED" || ctx.caseStatus === "BLOCKED") {
    return {
      ruleId: "policy_blocked",
      strategy: "NO_ACTION",
      rationale: "Policy engine has blocked automated recovery for this case; no action is proposed.",
      confidence: 1,
      riskLevel: "LOW",
      expectedOutcome: {
        successProbability: 0,
        description: "Blocked by policy; recovery deferred to manual handling.",
        revenueRecoverableMinor: 0,
      },
      proposedActions: [],
      stoppingConditions: [stop("POLICY_BLOCK", "Policy engine returned BLOCK for this case.")],
    };
  }

  // 2) Case already closed in a terminal state — do not re-open.
  if (TERMINAL_STATUSES.has(ctx.caseStatus)) {
    return {
      ruleId: "case_terminal",
      strategy: "NO_ACTION",
      rationale: `Case is in a terminal state (${ctx.caseStatus}); no further recovery is attempted.`,
      confidence: 1,
      riskLevel: "LOW",
      expectedOutcome: {
        successProbability: 0,
        description: "Case closed; no further automated recovery.",
        revenueRecoverableMinor: 0,
      },
      proposedActions: [],
      stoppingConditions: [stop("MAX_ATTEMPTS", `Case reached terminal state ${ctx.caseStatus}.`)],
    };
  }

  // 3) Unknown / unclassified — never guess with money; route to a human.
  if (rootCause === null || rootCause === "UNKNOWN") {
    return humanReview(
      ctx,
      "unknown_root_cause",
      "Root cause is unknown/unclassified; a human should decide the recovery approach.",
      "HIGH",
    );
  }

  // 4) CRITICAL severity — high value / high risk always gets human eyes.
  if (severity === "CRITICAL") {
    return humanReview(
      ctx,
      "critical_severity",
      "Case severity is CRITICAL (high value/high risk); require human review before any action.",
      "CRITICAL",
    );
  }

  // 5) Repeated bank decline — retrying a hard decline is wasteful.
  if (rootCause === "BANK_DECLINE" && repeated) {
    if (ctx.policyState === "REVIEW") {
      return humanReview(
        ctx,
        "repeated_bank_decline_review",
        `Bank declined ${retryCount} times; policy requests review, so route to a human.`,
        "HIGH",
      );
    }
    return {
      ruleId: "repeated_bank_decline_no_action",
      strategy: "NO_ACTION",
      rationale: `Bank declined ${retryCount} times; repeated automated attempts are unlikely to succeed and are not proposed.`,
      confidence: 0.85,
      riskLevel: "MEDIUM",
      expectedOutcome: {
        successProbability: 0.05,
        description: "Repeated hard decline; automated retry has very low expected success.",
        revenueRecoverableMinor: amountAtRiskMinor,
      },
      proposedActions: [],
      stoppingConditions: [
        stop("MAX_ATTEMPTS", `Repeated decline (${retryCount} attempts).`, STRATEGY_THRESHOLDS.maxRetryAttempts),
      ],
    };
  }

  // 6) Single bank decline — offer an alternate method via a fresh link.
  if (rootCause === "BANK_DECLINE") {
    const action = buildAction(ctx, {
      actionKind: "CREATE_PAYMENT_LINK",
      purpose: "Offer the customer an alternate payment method after a bank decline.",
      requiredCapability: CAPABILITY.CREATE_PAYMENT_LINK,
      riskLevel: "MEDIUM",
      withAmount: true,
      ttlSeconds: TTL_SECONDS.paymentLink,
      stoppingCondition: stop("TTL_EXPIRED", "Payment link expires; stop if unpaid."),
    });
    return {
      ruleId: "single_bank_decline_link",
      strategy: "SEND_PAYMENT_LINK",
      rationale: "A single bank decline may recover with an alternate instrument; propose a fresh payment link.",
      confidence: 0.7,
      riskLevel: "MEDIUM",
      expectedOutcome: {
        successProbability: 0.4,
        description: "A payment link lets the customer retry with another method.",
        revenueRecoverableMinor: amountAtRiskMinor,
      },
      proposedActions: [action],
      stoppingConditions: [
        stop("PAYMENT_RECOVERED", "Stop once the payment succeeds."),
        stop("TTL_EXPIRED", "Stop when the payment link expires."),
        stop("CUSTOMER_OPT_OUT", "Stop if the customer opts out."),
      ],
    };
  }

  // 7) Insufficient funds — nudge the customer; also offer a link to pay later.
  if (rootCause === "INSUFFICIENT_FUNDS") {
    const actions: ProposedRecoveryAction[] = [
      buildAction(ctx, {
        actionKind: "SEND_CUSTOMER_MESSAGE",
        purpose: "Remind the customer their payment failed for insufficient funds and invite them to retry.",
        requiredCapability: CAPABILITY.NOTIFY_CUSTOMER,
        riskLevel: "LOW",
        ttlSeconds: TTL_SECONDS.reminder,
        stoppingCondition: stop("CUSTOMER_OPT_OUT", "Stop if the customer opts out of messages."),
      }),
      buildAction(ctx, {
        actionKind: "CREATE_PAYMENT_LINK",
        purpose: "Give the customer a link to complete payment once funds are available.",
        requiredCapability: CAPABILITY.CREATE_PAYMENT_LINK,
        riskLevel: "MEDIUM",
        withAmount: true,
        ttlSeconds: TTL_SECONDS.paymentLink,
        stoppingCondition: stop("TTL_EXPIRED", "Payment link expires; stop if unpaid."),
      }),
    ];
    return {
      ruleId: "insufficient_funds_reminder",
      strategy: "CUSTOMER_REMINDER",
      rationale: "Insufficient funds usually clears with time; remind the customer and provide a link to pay.",
      confidence: 0.75,
      riskLevel: "LOW",
      expectedOutcome: {
        successProbability: 0.35,
        description: "A reminder plus a pay-later link recovers a share of NSF failures.",
        revenueRecoverableMinor: amountAtRiskMinor,
      },
      proposedActions: actions,
      stoppingConditions: [
        stop("PAYMENT_RECOVERED", "Stop once the payment succeeds."),
        stop("CUSTOMER_OPT_OUT", "Stop if the customer opts out."),
        stop("MAX_ATTEMPTS", "Send at most one reminder.", 1),
      ],
    };
  }

  // 8) Transient failure (timeout/gateway) — retry, unless the cap is reached.
  if (rootCause === "TIMEOUT" || rootCause === "GATEWAY_ERROR") {
    if (retryCount >= STRATEGY_THRESHOLDS.maxRetryAttempts) {
      return humanReview(
        ctx,
        "retry_cap_reached",
        `Transient failure but the retry cap (${STRATEGY_THRESHOLDS.maxRetryAttempts}) is reached; route to a human.`,
        "MEDIUM",
      );
    }
    const action = buildAction(ctx, {
      actionKind: "RETRY_PAYMENT",
      purpose: "Re-attempt the charge; timeout/gateway errors are typically transient.",
      requiredCapability: CAPABILITY.RETRY_PAYMENT,
      riskLevel: "LOW",
      withAmount: true,
      ttlSeconds: TTL_SECONDS.retry,
      stoppingCondition: stop(
        "MAX_ATTEMPTS",
        `Stop after ${STRATEGY_THRESHOLDS.maxRetryAttempts} total attempts.`,
        STRATEGY_THRESHOLDS.maxRetryAttempts,
      ),
    });
    return {
      ruleId: "transient_retry",
      strategy: "RETRY_PAYMENT",
      rationale: `${rootCause} is typically transient; a bounded retry has a good chance of success.`,
      confidence: 0.85,
      riskLevel: "LOW",
      expectedOutcome: {
        successProbability: 0.6,
        description: "Transient failures frequently succeed on a prompt retry.",
        revenueRecoverableMinor: amountAtRiskMinor,
      },
      proposedActions: [action],
      stoppingConditions: [
        stop("PAYMENT_RECOVERED", "Stop once the payment succeeds."),
        stop("MAX_ATTEMPTS", "Stop at the retry cap.", STRATEGY_THRESHOLDS.maxRetryAttempts),
        stop("TTL_EXPIRED", "Stop if the retry window elapses."),
      ],
    };
  }

  // 9) Abandonment / expired checkout — recover with a fresh checkout/link.
  if (rootCause === "CUSTOMER_ABANDONMENT" || rootCause === "EXPIRED_CHECKOUT" || ctx.hasExpiredLink) {
    const actions: ProposedRecoveryAction[] = [
      buildAction(ctx, {
        actionKind: "CREATE_PAYMENT_LINK",
        purpose: "Send a fresh checkout/payment link to recover an abandoned or expired checkout.",
        requiredCapability: CAPABILITY.CREATE_PAYMENT_LINK,
        riskLevel: "MEDIUM",
        withAmount: true,
        ttlSeconds: TTL_SECONDS.paymentLink,
        stoppingCondition: stop("TTL_EXPIRED", "Fresh link expires; stop if unpaid."),
      }),
    ];
    if (ctx.hasContactChannel) {
      actions.push(
        buildAction(ctx, {
          actionKind: "SEND_CUSTOMER_MESSAGE",
          purpose: "Nudge the customer to complete the checkout they abandoned.",
          requiredCapability: CAPABILITY.NOTIFY_CUSTOMER,
          riskLevel: "LOW",
          ttlSeconds: TTL_SECONDS.reminder,
          stoppingCondition: stop("CUSTOMER_OPT_OUT", "Stop if the customer opts out."),
        }),
      );
    }
    return {
      ruleId: "checkout_recovery",
      strategy: "CHECKOUT_RECOVERY",
      rationale: "Checkout was abandoned/expired; a fresh link (and optional nudge) can recover it.",
      confidence: 0.7,
      riskLevel: "MEDIUM",
      expectedOutcome: {
        successProbability: 0.45,
        description: "Fresh checkout links recover a meaningful share of abandoned carts.",
        revenueRecoverableMinor: amountAtRiskMinor,
      },
      proposedActions: actions,
      stoppingConditions: [
        stop("PAYMENT_RECOVERED", "Stop once the payment succeeds."),
        stop("TTL_EXPIRED", "Stop when the fresh link expires."),
        stop("CUSTOMER_OPT_OUT", "Stop if the customer opts out."),
      ],
    };
  }

  // 10) Fallback — anything unhandled defaults to the safe choice.
  return humanReview(
    ctx,
    "fallback_human_review",
    "No deterministic rule matched with confidence; route to a human for a decision.",
    "MEDIUM",
  );
}

/** Shared HUMAN_REVIEW decision builder (used by several rules). */
function humanReview(
  ctx: RecoveryStrategyContext,
  ruleId: string,
  rationale: string,
  riskLevel: RiskLevel,
): RuleDecision {
  const action = buildAction(ctx, {
    actionKind: "FLAG_FOR_HUMAN_REVIEW",
    purpose: "Place the case in the human review queue for a manual recovery decision.",
    requiredCapability: CAPABILITY.HUMAN_REVIEW,
    riskLevel,
    stoppingCondition: stop("HUMAN_DECISION_REQUIRED", "Awaiting a human decision."),
  });
  return {
    ruleId,
    strategy: "HUMAN_REVIEW",
    rationale,
    confidence: 0.6,
    riskLevel,
    expectedOutcome: {
      successProbability: 0,
      description: "Deferred to a human; no automated outcome is expected.",
      revenueRecoverableMinor: ctx.amountAtRiskMinor,
    },
    proposedActions: [action],
    stoppingConditions: [stop("HUMAN_DECISION_REQUIRED", "Stop until a human decides.")],
  };
}

/** Convenience type guard used by callers/policy pre-checks. */
export function isPolicyState(v: string): v is PolicyState {
  return v === "OK" || v === "REVIEW" || v === "BLOCKED";
}

// --- The provider ----------------------------------------------------------

export interface DeterministicProviderDeps {
  clock?: Clock;
}

export class DeterministicRecoveryStrategyProvider implements RecoveryStrategyProvider {
  readonly name = "deterministic-rules";
  private readonly clock: Clock;

  constructor(deps: DeterministicProviderDeps = {}) {
    this.clock = deps.clock ?? systemClock;
  }

  async generatePlan(ctx: RecoveryStrategyContext): Promise<RecoveryPlan> {
    const d = decideStrategy(ctx);
    const plan: RecoveryPlan = {
      caseId: ctx.caseId,
      strategy: d.strategy,
      rationale: d.rationale,
      confidence: d.confidence,
      expectedOutcome: d.expectedOutcome,
      riskLevel: d.riskLevel,
      proposedActions: d.proposedActions,
      stoppingConditions: d.stoppingConditions,
      evidence: [...baseEvidence(ctx), ...(d.extraEvidence ?? [])],
      modelMetadata: {
        provider: "deterministic",
        strategyEngine: this.name,
        version: STRATEGY_RULES_VERSION,
        deterministic: true,
        ruleId: d.ruleId,
      },
      generatedAt: this.clock.now().toISOString(),
    };
    return plan;
  }
}
