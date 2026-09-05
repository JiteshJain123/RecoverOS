/**
 * Integration: the Razorpay provider is only reachable THROUGH the execution
 * layer, which only runs it after policy authorization (and approval for
 * REVIEW). Proves a BLOCKed action and an unapproved REVIEW action never make an
 * HTTP call, while an ALLOWed action does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalService,
  InMemoryExecutionStore,
  RecoveryActionExecutor,
} from "@recoveros/execution";
import type { PolicyDecision, PolicyDecisionType } from "@recoveros/policy";
import type { RecoveryPlan } from "@recoveros/strategy";
import { RazorpayClient } from "./client";
import { RazorpayTestProvider } from "./razorpay-provider";
import { StaticRazorpayCredentialSource, defaultRazorpayConfig } from "./config";
import type { HttpResponseLike, HttpRequestInit, HttpTransport } from "./transport";

const A = { tenantId: "tenant_a" };

function linkRes(): HttpResponseLike {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({ id: "plink_1", status: "created", amount: 500_000, currency: "INR", short_url: "https://rzp.io/i/x" }),
  };
}

function build() {
  const requests: Array<{ url: string; init: HttpRequestInit }> = [];
  const transport: HttpTransport = async (url, init) => {
    requests.push({ url, init });
    return linkRes();
  };
  const client = new RazorpayClient({
    credentials: new StaticRazorpayCredentialSource({ keyId: "rzp_test_abc", keySecret: "s3cr3t" }),
    config: defaultRazorpayConfig({ timeoutMs: 1000 }),
    transport,
    now: () => 0,
  });
  const provider = new RazorpayTestProvider({ client });
  const store = new InMemoryExecutionStore({
    cases: [{ id: "case_1", tenantId: "tenant_a", status: "DETECTED", amountAtRiskMinor: 500_000, currency: "INR", resolvedAt: null }],
  });
  const clock = { now: () => new Date("2026-09-04T00:00:00.000Z") };
  const executor = new RecoveryActionExecutor({ store, provider, clock });
  const approvals = new ApprovalService({ store, clock });
  return { requests, executor, approvals };
}

function linkPlan(): RecoveryPlan {
  return {
    caseId: "case_1",
    strategy: "SEND_PAYMENT_LINK",
    rationale: "r",
    confidence: 0.7,
    expectedOutcome: { successProbability: 0.4, description: "d", revenueRecoverableMinor: 500_000 },
    riskLevel: "MEDIUM",
    proposedActions: [
      {
        actionKind: "CREATE_PAYMENT_LINK",
        purpose: "link",
        amountMinor: 500_000,
        currency: "INR",
        requiredCapability: "payment_link.create",
        riskLevel: "MEDIUM",
        idempotencyKey: "rk_case_1_CREATE_PAYMENT_LINK_beef0001",
        stoppingCondition: { type: "TTL_EXPIRED", description: "expires" },
      },
    ],
    stoppingConditions: [{ type: "PAYMENT_RECOVERED", description: "s" }],
    evidence: [{ label: "rootCause", detail: "BANK_DECLINE", source: "intelligence" }],
    modelMetadata: { provider: "deterministic", strategyEngine: "d", version: "v1", deterministic: true },
    generatedAt: "2026-09-04T00:00:00.000Z",
  };
}

function decision(d: PolicyDecisionType): PolicyDecision {
  return {
    decision: d,
    reason: d,
    violatedRules: [],
    requiredApproval: d === "REVIEW",
    maxAllowedAmountMinor: 1_500_000,
    allowedActionTypes: ["SEND_PAYMENT_LINK", "RETRY_PAYMENT", "CONTACT_CUSTOMER", "NO_ACTION"],
    evaluatedAt: "2026-09-04T00:00:00.000Z",
    policyVersion: 2,
  };
}

describe("policy gate — Razorpay is unreachable without authorization", () => {
  it("a BLOCKED action never calls Razorpay", async () => {
    const { requests, executor } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: linkPlan(), decision: decision("BLOCK") });
    assert.equal(auth.status, "blocked");
    assert.equal(requests.length, 0);
  });

  it("a REVIEW action cannot call Razorpay before approval, but can after", async () => {
    const { requests, executor, approvals } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: linkPlan(), decision: decision("REVIEW") });
    assert.equal(auth.status, "approval_required");

    const before = await executor.execute(A, { actionId: auth.action!.id });
    assert.equal(before.executed, false);
    assert.equal(before.reason, "not_approved");
    assert.equal(requests.length, 0, "no HTTP call before approval");

    await approvals.approve(A, auth.action!.id, { userId: "u1", role: "APPROVER" });
    const after = await executor.execute(A, { actionId: auth.action!.id });
    assert.equal(after.executed, true);
    assert.equal(after.action.state, "SUCCEEDED"); // LINK_CREATED → SUCCEEDED (no revenue)
    assert.equal(requests.length, 1, "exactly one HTTP call after approval");
  });

  it("an ALLOWED action calls Razorpay exactly once", async () => {
    const { requests, executor } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: linkPlan(), decision: decision("ALLOW") });
    assert.equal(auth.status, "authorized");
    const ex = await executor.execute(A, { actionId: auth.action!.id });
    assert.equal(ex.executed, true);
    assert.equal(ex.outcome?.externalReference, "plink_1");
    assert.equal(requests.length, 1);
  });
});
