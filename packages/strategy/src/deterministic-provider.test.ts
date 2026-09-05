/**
 * Tests for the deterministic strategy provider: one assertion per major failure
 * type plus the safety cases (recovered, blocked, unknown, high-value, repeated,
 * retry cap). Every produced plan is also checked against the strict schema so
 * the provider can never emit something the execution layer would reject.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DeterministicRecoveryStrategyProvider,
  decideStrategy,
} from "./deterministic-provider";
import type { Clock } from "./deterministic-provider";
import type {
  PolicyState,
  RecoveryCaseStatus,
  RecoveryStrategyContext,
} from "./provider";
import { validateRecoveryPlan } from "./types";
import type { RootCause, Severity } from "@recoveros/intelligence";

const fixedClock: Clock = { now: () => new Date("2026-09-03T10:00:00.000Z") };
const provider = new DeterministicRecoveryStrategyProvider({ clock: fixedClock });

function ctx(over: Partial<RecoveryStrategyContext> = {}): RecoveryStrategyContext {
  return {
    caseId: over.caseId ?? "case_1",
    tenantId: over.tenantId ?? "tenant_a",
    caseStatus: (over.caseStatus ?? "DETECTED") as RecoveryCaseStatus,
    paymentStatus: over.paymentStatus ?? "FAILED",
    reason: over.reason ?? "FAILED_PAYMENT",
    rootCause: (over.rootCause ?? "TIMEOUT") as RootCause | null,
    severity: (over.severity ?? "MEDIUM") as Severity | null,
    priorityScore: over.priorityScore ?? 40,
    amountAtRiskMinor: over.amountAtRiskMinor ?? 500_000,
    currency: over.currency ?? "INR",
    paymentId: over.paymentId ?? "pay_1",
    customerId: over.customerId ?? "cust_1",
    retryCount: over.retryCount ?? 0,
    hasContactChannel: over.hasContactChannel ?? true,
    hasExpiredLink: over.hasExpiredLink ?? false,
    policyState: (over.policyState ?? "OK") as PolicyState,
    signals: over.signals ?? [
      { type: "FAILED_PAYMENT", severity: "MEDIUM", rootCause: "TIMEOUT", confidence: 0.9, reason: "failed" },
    ],
    previousStrategy: over.previousStrategy,
  };
}

describe("DeterministicRecoveryStrategyProvider — strategy selection", () => {
  it("already-recovered payment → NO_ACTION with no proposed actions", async () => {
    const plan = await provider.generatePlan(ctx({ paymentStatus: "CAPTURED" }));
    assert.equal(plan.strategy, "NO_ACTION");
    assert.equal(plan.proposedActions.length, 0);
    assert.equal(plan.modelMetadata.ruleId, "already_recovered");
    assert.equal(plan.expectedOutcome.revenueRecoverableMinor, 0);
  });

  it("policy-blocked case → NO_ACTION (policy)", async () => {
    const plan = await provider.generatePlan(ctx({ policyState: "BLOCKED" }));
    assert.equal(plan.strategy, "NO_ACTION");
    assert.equal(plan.proposedActions.length, 0);
    assert.equal(plan.stoppingConditions[0]?.type, "POLICY_BLOCK");
  });

  it("unknown root cause → HUMAN_REVIEW", async () => {
    const plan = await provider.generatePlan(ctx({ rootCause: "UNKNOWN" }));
    assert.equal(plan.strategy, "HUMAN_REVIEW");
    assert.equal(plan.proposedActions[0]?.actionKind, "FLAG_FOR_HUMAN_REVIEW");
    assert.equal(plan.proposedActions[0]?.requiredCapability, "internal.review");
  });

  it("high-value CRITICAL case → HUMAN_REVIEW", async () => {
    const plan = await provider.generatePlan(
      ctx({ rootCause: "TIMEOUT", severity: "CRITICAL", amountAtRiskMinor: 5_000_000 }),
    );
    assert.equal(plan.strategy, "HUMAN_REVIEW");
    assert.equal(plan.riskLevel, "CRITICAL");
    assert.equal(plan.modelMetadata.ruleId, "critical_severity");
  });

  it("temporary timeout → RETRY_PAYMENT candidate with amount + TTL + stop", async () => {
    const plan = await provider.generatePlan(ctx({ rootCause: "TIMEOUT" }));
    assert.equal(plan.strategy, "RETRY_PAYMENT");
    const action = plan.proposedActions[0];
    assert.ok(action);
    assert.equal(action.actionKind, "RETRY_PAYMENT");
    assert.equal(action.requiredCapability, "payment.retry");
    assert.equal(action.amountMinor, 500_000);
    assert.equal(action.currency, "INR");
    assert.ok(action.ttlSeconds && action.ttlSeconds > 0);
    assert.equal(action.stoppingCondition.type, "MAX_ATTEMPTS");
  });

  it("gateway error → RETRY_PAYMENT candidate", async () => {
    const plan = await provider.generatePlan(ctx({ rootCause: "GATEWAY_ERROR" }));
    assert.equal(plan.strategy, "RETRY_PAYMENT");
  });

  it("insufficient funds → CUSTOMER_REMINDER with reminder + payment link", async () => {
    const plan = await provider.generatePlan(ctx({ rootCause: "INSUFFICIENT_FUNDS" }));
    assert.equal(plan.strategy, "CUSTOMER_REMINDER");
    const kinds = plan.proposedActions.map((a) => a.actionKind).sort();
    assert.deepEqual(kinds, ["CREATE_PAYMENT_LINK", "SEND_CUSTOMER_MESSAGE"]);
  });

  it("single bank decline → SEND_PAYMENT_LINK (alternate method)", async () => {
    const plan = await provider.generatePlan(ctx({ rootCause: "BANK_DECLINE", retryCount: 0 }));
    assert.equal(plan.strategy, "SEND_PAYMENT_LINK");
    assert.equal(plan.proposedActions[0]?.actionKind, "CREATE_PAYMENT_LINK");
  });

  it("repeated bank decline (policy OK) → NO_ACTION", async () => {
    const plan = await provider.generatePlan(
      ctx({ rootCause: "BANK_DECLINE", retryCount: 3, policyState: "OK" }),
    );
    assert.equal(plan.strategy, "NO_ACTION");
    assert.equal(plan.proposedActions.length, 0);
  });

  it("repeated bank decline (policy REVIEW) → HUMAN_REVIEW", async () => {
    const plan = await provider.generatePlan(
      ctx({ rootCause: "BANK_DECLINE", retryCount: 3, policyState: "REVIEW" }),
    );
    assert.equal(plan.strategy, "HUMAN_REVIEW");
  });

  it("checkout abandonment → CHECKOUT_RECOVERY (link + optional nudge)", async () => {
    const plan = await provider.generatePlan(
      ctx({ rootCause: "CUSTOMER_ABANDONMENT", paymentStatus: "CREATED", severity: "MEDIUM" }),
    );
    assert.equal(plan.strategy, "CHECKOUT_RECOVERY");
    assert.ok(plan.proposedActions.some((a) => a.actionKind === "CREATE_PAYMENT_LINK"));
  });

  it("expired checkout → CHECKOUT_RECOVERY", async () => {
    const plan = await provider.generatePlan(
      ctx({ rootCause: "EXPIRED_CHECKOUT", paymentStatus: "CREATED", hasExpiredLink: true }),
    );
    assert.equal(plan.strategy, "CHECKOUT_RECOVERY");
  });

  it("transient failure past the retry cap → HUMAN_REVIEW", async () => {
    const plan = await provider.generatePlan(ctx({ rootCause: "TIMEOUT", retryCount: 3 }));
    assert.equal(plan.strategy, "HUMAN_REVIEW");
    assert.equal(plan.modelMetadata.ruleId, "retry_cap_reached");
  });

  it("terminal case (REJECTED) → NO_ACTION", async () => {
    const plan = await provider.generatePlan(ctx({ caseStatus: "REJECTED" }));
    assert.equal(plan.strategy, "NO_ACTION");
  });
});

describe("DeterministicRecoveryStrategyProvider — invariants", () => {
  it("is not disguised as AI: metadata says deterministic", async () => {
    const plan = await provider.generatePlan(ctx());
    assert.equal(plan.modelMetadata.provider, "deterministic");
    assert.equal(plan.modelMetadata.deterministic, true);
    assert.equal(plan.modelMetadata.strategyEngine, "deterministic-rules");
    assert.ok(plan.modelMetadata.ruleId);
  });

  it("every plan carries evidence and at least one stopping condition", async () => {
    const plan = await provider.generatePlan(ctx());
    assert.ok(plan.evidence.length >= 1);
    assert.ok(plan.stoppingConditions.length >= 1);
  });

  it("produces schema-valid plans across every root cause / state", async () => {
    const causes: (RootCause | null)[] = [
      "BANK_DECLINE", "INSUFFICIENT_FUNDS", "TIMEOUT", "GATEWAY_ERROR",
      "CUSTOMER_ABANDONMENT", "EXPIRED_CHECKOUT", "UNKNOWN", null,
    ];
    const states: RecoveryCaseStatus[] = ["DETECTED", "RECOVERED", "BLOCKED", "REJECTED", "EXPIRED"];
    const policies: PolicyState[] = ["OK", "REVIEW", "BLOCKED"];
    for (const rootCause of causes) {
      for (const caseStatus of states) {
        for (const policyState of policies) {
          for (const retryCount of [0, 1, 3]) {
            const plan = await provider.generatePlan(
              ctx({ rootCause, caseStatus, policyState, retryCount, paymentStatus: "FAILED" }),
            );
            const res = validateRecoveryPlan(plan);
            assert.ok(res.valid, `invalid plan for ${rootCause}/${caseStatus}/${policyState}/${retryCount}`);
          }
        }
      }
    }
  });

  it("decideStrategy is a pure function (same input → identical decision)", () => {
    const c = ctx({ rootCause: "TIMEOUT" });
    assert.deepEqual(decideStrategy(c), decideStrategy(c));
  });
});
