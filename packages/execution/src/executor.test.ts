/**
 * RecoveryActionExecutor + ApprovalService tests: ALLOW/REVIEW authorization,
 * every execution safeguard (not-approved, expired, stale approval, policy
 * change, already-recovered, stopping conditions), idempotency / duplicate
 * execution, tenant isolation, role-based approval, and outcome verification.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RecoveryActionExecutor } from "./executor";
import { ApprovalService } from "./approval";
import { InMemoryExecutionStore } from "./in-memory-store";
import { SimulatedRecoveryProvider } from "./simulated-provider";
import { ActionNotFoundError, InvalidActionTransitionError, UnauthorizedApprovalError } from "./errors";
import type { PaymentRecoveryProvider, RecoveryProviderRequest, RecoveryProviderResult } from "./provider";
import type { PolicyDecision, PolicyDecisionType } from "@recoveros/policy";
import type { RecoveryPlan, Strategy } from "@recoveros/strategy";

const A = { tenantId: "tenant_a" };

function mutableClock(initial: string) {
  let cur = new Date(initial);
  return { clock: { now: () => new Date(cur) }, set: (iso: string) => (cur = new Date(iso)) };
}

function plan(over: Partial<RecoveryPlan> = {}): RecoveryPlan {
  const strategy: Strategy = over.strategy ?? "RETRY_PAYMENT";
  return {
    caseId: over.caseId ?? "case_1",
    strategy,
    rationale: "r",
    confidence: over.confidence ?? 0.85,
    expectedOutcome: { successProbability: 0.6, description: "d", revenueRecoverableMinor: 500_000 },
    riskLevel: over.riskLevel ?? "LOW",
    proposedActions: over.proposedActions ?? [
      {
        actionKind: "RETRY_PAYMENT",
        purpose: "retry",
        amountMinor: 500_000,
        currency: "INR",
        requiredCapability: "payment.retry",
        riskLevel: "LOW",
        idempotencyKey: "rk_case_1_RETRY_PAYMENT_aaaa1111",
        stoppingCondition: { type: "MAX_ATTEMPTS", description: "cap", limit: 3 },
      },
    ],
    stoppingConditions: [{ type: "PAYMENT_RECOVERED", description: "s" }],
    evidence: [{ label: "rootCause", detail: "TIMEOUT", source: "intelligence" }],
    modelMetadata: { provider: "deterministic", strategyEngine: "d", version: "v1", deterministic: true },
    generatedAt: "2026-09-04T00:00:00.000Z",
  };
}

function decision(d: PolicyDecisionType, policyVersion: number | null = 2): PolicyDecision {
  return {
    decision: d,
    reason: d,
    violatedRules: [],
    requiredApproval: d === "REVIEW",
    maxAllowedAmountMinor: 1_500_000,
    allowedActionTypes: ["RETRY_PAYMENT", "SEND_PAYMENT_LINK", "CONTACT_CUSTOMER", "NO_ACTION"],
    evaluatedAt: "2026-09-04T00:00:00.000Z",
    policyVersion,
  };
}

function build(opts: {
  caseStatus?: string;
  clockAt?: string;
  provider?: PaymentRecoveryProvider;
  config?: { executionTtlMs?: number; approvalTtlMs?: number };
} = {}) {
  const store = new InMemoryExecutionStore({
    cases: [
      {
        id: "case_1",
        tenantId: "tenant_a",
        status: opts.caseStatus ?? "DETECTED",
        amountAtRiskMinor: 500_000,
        currency: "INR",
        resolvedAt: null,
      },
    ],
  });
  const mc = mutableClock(opts.clockAt ?? "2026-09-04T00:00:00.000Z");
  const provider = opts.provider ?? new SimulatedRecoveryProvider();
  const executor = new RecoveryActionExecutor({ store, provider, clock: mc.clock, config: opts.config });
  const approvals = new ApprovalService({ store, clock: mc.clock });
  return { store, executor, approvals, mc, provider };
}

describe("executor — ALLOW → execute → outcome", () => {
  it("authorizes, executes, and verifies a successful recovery", async () => {
    const { store, executor } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    assert.equal(auth.status, "authorized");
    assert.equal(auth.action?.state, "APPROVED");

    const ex = await executor.execute(A, {
      actionId: auth.action!.id,
      metadata: { rootCause: "TIMEOUT" }, // simulator → SUCCEEDED
    });
    assert.equal(ex.executed, true);
    assert.equal(ex.action.state, "SUCCEEDED");
    assert.equal(ex.recoveredAmountMinor, 500_000);
    // Case marked recovered ONLY because the provider reported success.
    const c = await store.getCase(A, "case_1");
    assert.equal(c?.status, "RECOVERED");
    // Full audit trail present.
    const actions = store.audits.map((a) => a.action);
    assert.ok(actions.includes("recovery.action.proposed"));
    assert.ok(actions.includes("recovery.action.executing"));
    assert.ok(actions.includes("recovery.action.succeeded"));
  });

  it("records a FAILED outcome without crediting revenue", async () => {
    const { store, executor } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    const ex = await executor.execute(A, { actionId: auth.action!.id, metadata: { simScenario: "retry_fail" } });
    assert.equal(ex.action.state, "FAILED");
    assert.equal(ex.recoveredAmountMinor, 0);
    assert.equal((await store.getCase(A, "case_1"))?.status, "DETECTED");
  });

  it("treats a provider timeout as a failed (uncredited) execution", async () => {
    const { executor } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    const ex = await executor.execute(A, { actionId: auth.action!.id, metadata: { simScenario: "timeout" } });
    assert.equal(ex.outcome?.outcome, "TIMEOUT");
    assert.equal(ex.action.state, "FAILED");
    assert.equal(ex.recoveredAmountMinor, 0);
  });
});

describe("executor — REVIEW → approval → execute", () => {
  it("requires approval, blocks execution until approved, then executes", async () => {
    const { executor, approvals } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("REVIEW") });
    assert.equal(auth.status, "approval_required");
    assert.equal(auth.action?.state, "APPROVAL_REQUIRED");

    // Cannot execute before approval.
    const blocked = await executor.execute(A, { actionId: auth.action!.id, metadata: { rootCause: "TIMEOUT" } });
    assert.equal(blocked.executed, false);
    assert.equal(blocked.reason, "not_approved");

    // Approve, then execute.
    const approved = await approvals.approve(A, auth.action!.id, { userId: "u1", role: "APPROVER" });
    assert.equal(approved.state, "APPROVED");
    const ex = await executor.execute(A, { actionId: auth.action!.id, metadata: { rootCause: "TIMEOUT" } });
    assert.equal(ex.executed, true);
    assert.equal(ex.action.state, "SUCCEEDED");
  });
});

describe("executor — BLOCK", () => {
  it("creates no action and audits the block", async () => {
    const { store, executor } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("BLOCK") });
    assert.equal(auth.status, "blocked");
    assert.equal(auth.action, null);
    assert.equal(store.actions.length, 0);
    assert.ok(store.audits.some((a) => a.action === "recovery.action.blocked"));
  });
});

describe("executor — safeguards", () => {
  it("blocks a stale approval", async () => {
    // Execution window is long, but approval freshness is short.
    const { executor, approvals, mc } = build({ config: { executionTtlMs: 30 * 24 * 3600 * 1000, approvalTtlMs: 3600 * 1000 } });
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("REVIEW") });
    await approvals.approve(A, auth.action!.id, { userId: "u1", role: "APPROVER" });
    mc.set("2026-09-04T06:00:00.000Z"); // > 1h after approval, within exec window
    const ex = await executor.execute(A, { actionId: auth.action!.id, metadata: { rootCause: "TIMEOUT" } });
    assert.equal(ex.executed, false);
    assert.equal(ex.reason, "stale_approval");
    assert.equal(ex.action.state, "EXPIRED");
  });

  it("blocks when the policy changed after approval", async () => {
    const { executor } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW", 2) });
    const ex = await executor.execute(A, { actionId: auth.action!.id, currentPolicyVersion: 3, metadata: { rootCause: "TIMEOUT" } });
    assert.equal(ex.reason, "policy_changed");
    assert.equal(ex.action.state, "CANCELLED");
  });

  it("blocks when the payment is already recovered", async () => {
    const { executor } = build({ caseStatus: "CAPTURED" });
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    const ex = await executor.execute(A, { actionId: auth.action!.id, metadata: { rootCause: "TIMEOUT" } });
    assert.equal(ex.reason, "already_recovered");
    assert.equal(ex.action.state, "CANCELLED");
  });

  it("blocks when a stopping condition is met", async () => {
    const { executor } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    const ex = await executor.execute(A, {
      actionId: auth.action!.id,
      stopping: { paymentRecovered: true },
      metadata: { rootCause: "TIMEOUT" },
    });
    assert.equal(ex.reason, "stopping_condition:payment_recovered");
    assert.equal(ex.action.state, "CANCELLED");
  });
});

describe("executor — idempotency & duplicate execution", () => {
  it("authorize is idempotent per idempotency key (no duplicate actions)", async () => {
    const { store, executor } = build();
    const a1 = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    const a2 = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    assert.equal(a2.status, "duplicate");
    assert.equal(a2.action?.id, a1.action?.id);
    assert.equal(store.actions.length, 1);
  });

  it("never executes twice for the same action", async () => {
    let calls = 0;
    const counting: PaymentRecoveryProvider = {
      name: "counting",
      async execute(r: RecoveryProviderRequest): Promise<RecoveryProviderResult> {
        calls += 1;
        return { outcome: "SUCCEEDED", externalReference: "sim_x", recoveredAmountMinor: r.amountMinor ?? 0, detail: "ok" };
      },
    };
    const { executor } = build({ provider: counting });
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    const first = await executor.execute(A, { actionId: auth.action!.id, metadata: {} });
    const second = await executor.execute(A, { actionId: auth.action!.id, metadata: {} });
    assert.equal(first.executed, true);
    assert.equal(second.executed, false);
    assert.equal(second.alreadyFinal, true);
    assert.equal(calls, 1); // provider invoked exactly once
  });
});

describe("executor — tenant isolation", () => {
  it("cannot execute or approve another tenant's action", async () => {
    const { executor, approvals } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("REVIEW") });
    await assert.rejects(
      () => executor.execute({ tenantId: "tenant_b" }, { actionId: auth.action!.id, metadata: {} }),
      ActionNotFoundError,
    );
    await assert.rejects(
      () => approvals.approve({ tenantId: "tenant_b" }, auth.action!.id, { userId: "u1", role: "ADMIN" }),
      ActionNotFoundError,
    );
  });
});

describe("approval — role based", () => {
  it("a VIEWER cannot approve; an APPROVER can", async () => {
    const { executor, approvals } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("REVIEW") });
    await assert.rejects(
      () => approvals.approve(A, auth.action!.id, { userId: "v1", role: "VIEWER" }),
      UnauthorizedApprovalError,
    );
    const ok = await approvals.approve(A, auth.action!.id, { userId: "a1", role: "APPROVER" });
    assert.equal(ok.state, "APPROVED");
  });

  it("approving a non-review action is an invalid transition", async () => {
    const { executor, approvals } = build();
    const auth = await executor.authorize(A, { caseId: "case_1", plan: plan(), decision: decision("ALLOW") });
    // Already APPROVED (auto) → approving again is illegal.
    await assert.rejects(
      () => approvals.approve(A, auth.action!.id, { userId: "a1", role: "APPROVER" }),
      InvalidActionTransitionError,
    );
  });
});
