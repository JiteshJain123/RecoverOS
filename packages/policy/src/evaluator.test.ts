/**
 * PolicyEvaluator tests: ALLOW / REVIEW / BLOCK across the realistic financial
 * safety rules, driven by configurable Policy limits.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolicyEvaluator } from "./evaluator";
import type { PolicyEvaluationInput, PolicyCaseView, PolicyPaymentContext } from "./evaluator";
import type { PolicyLimits } from "./config";
import type { RecoveryPlan, Strategy, ProposedRecoveryAction } from "@recoveros/strategy";

const NOW = new Date("2026-09-04T00:00:00.000Z");
const evaluator = new PolicyEvaluator();

const LIMITS: PolicyLimits = {
  maxRetryAmountMinor: 1_500_000,
  reviewAmountMinor: 1_000_000,
  minConfidence: 0.5,
  maxRetriesPerCase: 2,
  allowedActions: ["RETRY_PAYMENT", "SEND_PAYMENT_LINK", "CONTACT_CUSTOMER"],
};

function action(over: Partial<ProposedRecoveryAction> = {}): ProposedRecoveryAction {
  return {
    actionKind: over.actionKind ?? "RETRY_PAYMENT",
    purpose: "retry",
    amountMinor: over.amountMinor ?? 500_000,
    currency: over.currency ?? "INR",
    requiredCapability: over.requiredCapability ?? "payment.retry",
    riskLevel: over.riskLevel ?? "LOW",
    idempotencyKey: over.idempotencyKey ?? "rk_case_1_RETRY_PAYMENT_0000abcd",
    stoppingCondition: over.stoppingCondition ?? { type: "MAX_ATTEMPTS", description: "cap", limit: 3 },
    ...(over.ttlSeconds !== undefined ? { ttlSeconds: over.ttlSeconds } : {}),
  };
}

function plan(over: Partial<RecoveryPlan> = {}): RecoveryPlan {
  const strategy: Strategy = over.strategy ?? "RETRY_PAYMENT";
  return {
    caseId: over.caseId ?? "case_1",
    strategy,
    rationale: "r",
    confidence: over.confidence ?? 0.8,
    expectedOutcome: over.expectedOutcome ?? {
      successProbability: 0.6,
      description: "d",
      revenueRecoverableMinor: 500_000,
    },
    riskLevel: over.riskLevel ?? "LOW",
    proposedActions: over.proposedActions ?? (strategy === "NO_ACTION" || strategy === "HUMAN_REVIEW" ? [] : [action()]),
    stoppingConditions: over.stoppingConditions ?? [{ type: "PAYMENT_RECOVERED", description: "s" }],
    evidence: over.evidence ?? [{ label: "rootCause", detail: "TIMEOUT", source: "intelligence" }],
    modelMetadata: over.modelMetadata ?? {
      provider: "deterministic",
      strategyEngine: "deterministic-rules",
      version: "strategy-rules-v1",
      deterministic: true,
    },
    generatedAt: NOW.toISOString(),
  };
}

function caseView(over: Partial<PolicyCaseView> = {}): PolicyCaseView {
  return {
    id: over.id ?? "case_1",
    tenantId: over.tenantId ?? "tenant_a",
    status: over.status ?? "DETECTED",
    rootCause: over.rootCause ?? "TIMEOUT",
    severity: over.severity ?? "MEDIUM",
    amountAtRiskMinor: over.amountAtRiskMinor ?? 500_000,
    currency: over.currency ?? "INR",
    retryCount: over.retryCount ?? 0,
    openedAt: over.openedAt ?? new Date("2026-09-01T00:00:00.000Z"),
    expiresAt: over.expiresAt,
  };
}

function payment(over: Partial<PolicyPaymentContext> = {}): PolicyPaymentContext {
  return {
    paymentStatus: over.paymentStatus ?? "FAILED",
    alreadyRecovered: over.alreadyRecovered ?? false,
    usedIdempotencyKeys: over.usedIdempotencyKeys ?? [],
  };
}

function evalInput(over: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    tenant: { tenantId: "tenant_a" },
    case: over.case ?? caseView(),
    plan: over.plan ?? plan(),
    policy: over.policy ?? { version: 2, limits: LIMITS },
    payment: over.payment ?? payment(),
    now: over.now ?? NOW,
  };
}

describe("PolicyEvaluator — ALLOW", () => {
  it("allows a compliant low-amount retry", () => {
    const d = evaluator.evaluate(evalInput());
    assert.equal(d.decision, "ALLOW");
    assert.equal(d.requiredApproval, false);
    assert.equal(d.policyVersion, 2);
    assert.equal(d.maxAllowedAmountMinor, 1_500_000);
  });

  it("allows NO_ACTION without review", () => {
    const d = evaluator.evaluate(evalInput({ plan: plan({ strategy: "NO_ACTION" }) }));
    assert.equal(d.decision, "ALLOW");
  });
});

describe("PolicyEvaluator — REVIEW", () => {
  it("reviews low confidence", () => {
    const d = evaluator.evaluate(evalInput({ plan: plan({ confidence: 0.3 }) }));
    assert.equal(d.decision, "REVIEW");
    assert.equal(d.requiredApproval, true);
    assert.ok(d.violatedRules.includes("low_confidence"));
  });

  it("reviews a high-risk plan", () => {
    const d = evaluator.evaluate(evalInput({ plan: plan({ riskLevel: "HIGH" }) }));
    assert.equal(d.decision, "REVIEW");
    assert.ok(d.violatedRules.includes("high_risk"));
  });

  it("reviews an amount in the review band", () => {
    const d = evaluator.evaluate(
      evalInput({
        case: caseView({ amountAtRiskMinor: 1_200_000 }),
        plan: plan({ proposedActions: [action({ amountMinor: 1_200_000 })] }),
      }),
    );
    assert.equal(d.decision, "REVIEW");
    assert.ok(d.violatedRules.includes("amount_requires_review"));
  });

  it("reviews a HUMAN_REVIEW strategy", () => {
    const d = evaluator.evaluate(evalInput({ plan: plan({ strategy: "HUMAN_REVIEW", riskLevel: "MEDIUM" }) }));
    assert.equal(d.decision, "REVIEW");
  });
});

describe("PolicyEvaluator — BLOCK", () => {
  it("blocks an amount above the hard ceiling", () => {
    const d = evaluator.evaluate(
      evalInput({
        case: caseView({ amountAtRiskMinor: 2_000_000 }),
        plan: plan({ proposedActions: [action({ amountMinor: 2_000_000 })] }),
      }),
    );
    assert.equal(d.decision, "BLOCK");
    assert.ok(d.violatedRules.includes("amount_above_max"));
  });

  it("blocks an action outside the allowed list", () => {
    const d = evaluator.evaluate(
      evalInput({ policy: { version: 1, limits: { ...LIMITS, allowedActions: ["RETRY_PAYMENT"] } },
        plan: plan({ strategy: "SEND_PAYMENT_LINK", proposedActions: [action({ actionKind: "CREATE_PAYMENT_LINK", requiredCapability: "payment_link.create" })] }),
      }),
    );
    assert.equal(d.decision, "BLOCK");
    assert.ok(d.violatedRules.includes("action_not_allowed"));
  });

  it("blocks an already-recovered payment", () => {
    const d = evaluator.evaluate(evalInput({ payment: payment({ alreadyRecovered: true, paymentStatus: "CAPTURED" }) }));
    assert.equal(d.decision, "BLOCK");
    assert.ok(d.violatedRules.includes("already_recovered"));
  });

  it("blocks a duplicate idempotency key", () => {
    const d = evaluator.evaluate(
      evalInput({ payment: payment({ usedIdempotencyKeys: ["rk_case_1_RETRY_PAYMENT_0000abcd"] }) }),
    );
    assert.equal(d.decision, "BLOCK");
    assert.ok(d.violatedRules.includes("duplicate_idempotency_key"));
  });

  it("blocks an expired case", () => {
    const d = evaluator.evaluate(
      evalInput({ case: caseView({ openedAt: new Date("2026-01-01T00:00:00.000Z") }) }),
    );
    assert.equal(d.decision, "BLOCK");
    assert.ok(d.violatedRules.includes("expired_case"));
  });

  it("blocks excessive retries", () => {
    const d = evaluator.evaluate(evalInput({ case: caseView({ retryCount: 2 }) }));
    assert.equal(d.decision, "BLOCK");
    assert.ok(d.violatedRules.includes("excessive_retries"));
  });

  it("blocks a stopped case", () => {
    const d = evaluator.evaluate(evalInput({ case: caseView({ status: "REJECTED" }) }));
    assert.equal(d.decision, "BLOCK");
    assert.ok(d.violatedRules.includes("stopped_case"));
  });

  it("BLOCK dominates REVIEW", () => {
    // Low confidence (review) AND already recovered (block) → BLOCK.
    const d = evaluator.evaluate(
      evalInput({ plan: plan({ confidence: 0.1 }), payment: payment({ alreadyRecovered: true }) }),
    );
    assert.equal(d.decision, "BLOCK");
    assert.ok(d.violatedRules.includes("low_confidence"));
    assert.ok(d.violatedRules.includes("already_recovered"));
  });
});
