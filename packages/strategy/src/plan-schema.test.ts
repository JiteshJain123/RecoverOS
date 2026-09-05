/**
 * Tests for RecoveryPlan validation. A malformed or internally inconsistent plan
 * must be rejected so it can never enter the execution/authorization layer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertValidRecoveryPlan,
  RecoveryPlanValidationError,
  validateRecoveryPlan,
  type RecoveryPlan,
} from "./types";

function validPlan(): RecoveryPlan {
  return {
    caseId: "case_1",
    strategy: "RETRY_PAYMENT",
    rationale: "Transient timeout; bounded retry.",
    confidence: 0.85,
    expectedOutcome: {
      successProbability: 0.6,
      description: "Transient failures often succeed on retry.",
      revenueRecoverableMinor: 500_000,
    },
    riskLevel: "LOW",
    proposedActions: [
      {
        actionKind: "RETRY_PAYMENT",
        purpose: "Re-attempt the charge.",
        amountMinor: 500_000,
        currency: "INR",
        requiredCapability: "payment.retry",
        riskLevel: "LOW",
        ttlSeconds: 86_400,
        idempotencyKey: "rk_case_1_RETRY_PAYMENT_abc12345",
        stoppingCondition: { type: "MAX_ATTEMPTS", description: "Stop at cap.", limit: 3 },
      },
    ],
    stoppingConditions: [{ type: "PAYMENT_RECOVERED", description: "Stop on success." }],
    evidence: [{ label: "rootCause", detail: "TIMEOUT", source: "intelligence" }],
    modelMetadata: {
      provider: "deterministic",
      strategyEngine: "deterministic-rules",
      version: "strategy-rules-v1",
      deterministic: true,
      ruleId: "transient_retry",
    },
    generatedAt: "2026-09-03T10:00:00.000Z",
  };
}

describe("validateRecoveryPlan", () => {
  it("accepts a well-formed plan", () => {
    const res = validateRecoveryPlan(validPlan());
    assert.ok(res.valid);
  });

  it("rejects confidence out of [0,1]", () => {
    const bad = { ...validPlan(), confidence: 1.5 };
    const res = validateRecoveryPlan(bad);
    assert.equal(res.valid, false);
  });

  it("rejects an unknown strategy", () => {
    const bad = { ...validPlan(), strategy: "TELEPORT_FUNDS" };
    assert.equal(validateRecoveryPlan(bad).valid, false);
  });

  it("rejects a money-bearing action without an amount", () => {
    const p = validPlan();
    delete (p.proposedActions[0] as { amountMinor?: number }).amountMinor;
    const res = validateRecoveryPlan(p);
    assert.equal(res.valid, false);
    assert.ok(res.valid === false && res.issues.some((i) => i.path.includes("amountMinor")));
  });

  it("rejects a NO_ACTION plan that still proposes actions", () => {
    const p = { ...validPlan(), strategy: "NO_ACTION" as const };
    assert.equal(validateRecoveryPlan(p).valid, false);
  });

  it("rejects a HUMAN_REVIEW plan smuggling a financial action", () => {
    const p = validPlan();
    p.strategy = "HUMAN_REVIEW";
    // keep the RETRY_PAYMENT financial action → must be rejected
    assert.equal(validateRecoveryPlan(p).valid, false);
  });

  it("rejects a strategy missing its defining action", () => {
    const p = validPlan();
    const a0 = p.proposedActions[0];
    assert.ok(a0);
    a0.actionKind = "SEND_CUSTOMER_MESSAGE";
    delete (a0 as { amountMinor?: number }).amountMinor;
    delete (a0 as { currency?: string }).currency;
    // strategy RETRY_PAYMENT but no RETRY_PAYMENT action
    assert.equal(validateRecoveryPlan(p).valid, false);
  });

  it("rejects duplicate idempotency keys within a plan", () => {
    const p = validPlan();
    p.strategy = "CUSTOMER_REMINDER";
    p.proposedActions = [
      {
        actionKind: "SEND_CUSTOMER_MESSAGE",
        purpose: "remind",
        requiredCapability: "customer.notify",
        riskLevel: "LOW",
        idempotencyKey: "dup_key",
        stoppingCondition: { type: "CUSTOMER_OPT_OUT", description: "opt out" },
      },
      {
        actionKind: "CREATE_PAYMENT_LINK",
        purpose: "link",
        amountMinor: 500_000,
        currency: "INR",
        requiredCapability: "payment_link.create",
        riskLevel: "MEDIUM",
        idempotencyKey: "dup_key",
        stoppingCondition: { type: "TTL_EXPIRED", description: "expires" },
      },
    ];
    const res = validateRecoveryPlan(p);
    assert.equal(res.valid, false);
  });

  it("rejects an invalid currency code", () => {
    const p = validPlan();
    const a0 = p.proposedActions[0];
    assert.ok(a0);
    a0.currency = "rupee";
    assert.equal(validateRecoveryPlan(p).valid, false);
  });

  it("rejects unknown extra keys (strict schema)", () => {
    const p = { ...validPlan(), sneaky: true };
    assert.equal(validateRecoveryPlan(p).valid, false);
  });

  it("assertValidRecoveryPlan throws on an invalid plan", () => {
    assert.throws(
      () => assertValidRecoveryPlan({ ...validPlan(), confidence: 9 }),
      RecoveryPlanValidationError,
    );
  });

  it("assertValidRecoveryPlan returns the typed plan when valid", () => {
    const plan = assertValidRecoveryPlan(validPlan());
    assert.equal(plan.strategy, "RETRY_PAYMENT");
  });
});
