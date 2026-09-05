import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkspace, WORKSPACES, DEFAULT_WORKSPACE } from "./workspaces";
import { friendlyError, errorTitle } from "./errors";
import { lifecycleFor } from "./lifecycle";
import { caseStatusLabel } from "./badges";
import { groupAttention } from "./attention";
import { toApprovalItem, pendingAction } from "./approvals";
import type { CaseDetailDTO, CaseListItemDTO } from "./types";

// --- Status vocabulary (domain-honest, never claims "Success") --------------

test("caseStatusLabel uses professional vocabulary and never says 'Success'", () => {
  assert.equal(caseStatusLabel("DETECTED"), "At Risk");
  assert.equal(caseStatusLabel("PENDING_APPROVAL"), "Awaiting Approval");
  assert.equal(caseStatusLabel("RECOVERED"), "Verified Recovery");
  assert.equal(caseStatusLabel("FAILED"), "Recovery Failed");
  assert.equal(caseStatusLabel("BLOCKED"), "Safely Prevented");
  for (const s of ["DETECTED", "ANALYZING", "PROPOSED", "PENDING_APPROVAL", "AUTHORIZED", "EXECUTING", "RECOVERED", "FAILED", "BLOCKED", "REJECTED", "EXPIRED"] as const) {
    assert.doesNotMatch(caseStatusLabel(s), /success/i, `${s} label must not say "Success"`);
  }
});

// --- Tenant isolation assumptions ------------------------------------------

test("resolveWorkspace only ever returns an allowlisted tenant (no arbitrary tenantId)", () => {
  assert.equal(resolveWorkspace("acme-store").tenantId, "seed_tenant_1");
  assert.equal(resolveWorkspace("globex-digital").tenantId, "seed_tenant_2");
  // Unknown / injected keys fall back to the default — never an attacker-chosen tenant.
  assert.equal(resolveWorkspace("seed_tenant_999").tenantId, DEFAULT_WORKSPACE.tenantId);
  assert.equal(resolveWorkspace("../../etc").tenantId, DEFAULT_WORKSPACE.tenantId);
  assert.equal(resolveWorkspace(undefined).tenantId, DEFAULT_WORKSPACE.tenantId);
  // The allowlist is exactly the two seeded tenants.
  assert.deepEqual(
    WORKSPACES.map((w) => w.tenantId).sort(),
    ["seed_tenant_1", "seed_tenant_2"],
  );
});

// --- API error handling -----------------------------------------------------

test("friendlyError maps known codes and never leaks internals for unknown ones", () => {
  assert.match(friendlyError({ status: 503, code: "api_unavailable", message: "x" }), /API is not reachable/);
  assert.match(friendlyError({ status: 404, code: "not_found", message: "x" }), /couldn't find/);
  assert.match(friendlyError({ status: 403, code: "forbidden", message: "x" }), /not permitted/);
  // Unknown code → falls back to the (safe) server message, then generic.
  assert.equal(friendlyError({ status: 500, code: "weird_internal_code", message: "Safe message" }), "Safe message");
  assert.equal(errorTitle({ status: 401, code: "tenant_context_required", message: "" }), "No workspace selected");
});

// --- Lifecycle mapping ------------------------------------------------------

test("lifecycleFor marks recovered as fully done and failed as stopped", () => {
  const recovered = lifecycleFor("RECOVERED");
  assert.ok(recovered.steps.every((s) => s.state === "done"));
  assert.equal(recovered.stopReason, null);

  const failed = lifecycleFor("FAILED");
  assert.ok(failed.steps.some((s) => s.state === "stopped"));
  assert.match(failed.stopReason ?? "", /not a successful capture/);

  const blocked = lifecycleFor("BLOCKED");
  assert.match(blocked.stopReason ?? "", /Policy blocked/);
});

// --- Needs-attention grouping ----------------------------------------------

function caseItem(over: Partial<CaseListItemDTO>): CaseListItemDTO {
  return {
    id: "c1",
    status: "DETECTED",
    reason: "FAILED_PAYMENT",
    rootCause: "TIMEOUT",
    severity: "HIGH",
    priorityScore: 50,
    amountAtRiskMinor: 100000,
    currency: "INR",
    paymentId: "pay_1",
    customerId: "cust_1",
    openedAt: "2026-09-01T00:00:00.000Z",
    lastDetectedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

test("groupAttention buckets high-priority, pending, failed, blocked", () => {
  const cases = [
    caseItem({ id: "hp", status: "DETECTED", priorityScore: 90 }),
    caseItem({ id: "pa", status: "PENDING_APPROVAL", priorityScore: 30 }),
    caseItem({ id: "fl", status: "FAILED" }),
    caseItem({ id: "bl", status: "BLOCKED" }),
    caseItem({ id: "lo", status: "DETECTED", priorityScore: 10 }),
  ];
  const b = groupAttention(cases);
  assert.deepEqual(b.highPriority.map((c) => c.id), ["hp"]);
  assert.deepEqual(b.pendingApprovals.map((c) => c.id), ["pa"]);
  assert.deepEqual(b.failedRecoveries.map((c) => c.id), ["fl"]);
  assert.deepEqual(b.policyBlocks.map((c) => c.id), ["bl"]);
});

// --- Approval assembly ------------------------------------------------------

function detail(over: Partial<CaseDetailDTO>): CaseDetailDTO {
  return {
    id: "case_1",
    tenantId: "seed_tenant_1",
    status: "PENDING_APPROVAL",
    reason: "FAILED_PAYMENT",
    rootCause: "GATEWAY_ERROR",
    severity: "HIGH",
    priorityScore: 72,
    amountAtRiskMinor: 250000,
    currency: "INR",
    money: { unit: "minor", exponent: 2, currency: "INR" },
    openedAt: "2026-09-01T00:00:00.000Z",
    resolvedAt: null,
    lastDetectedAt: null,
    detectionRuleVersion: "detect-v1",
    customer: { id: "cust_1", name: "Nadia Khan", email: null, phone: null },
    payment: {
      id: "pay_1", status: "FAILED", method: null, amountMinor: 250000, currency: "INR",
      failureCode: "gateway_error", failureReason: null, paymentRef: "seed_rzp_payment_1", orderRef: null,
      createdAt: "2026-09-01T00:00:00.000Z", capturedAt: null,
    },
    paymentHistory: [],
    eventTimeline: [{ eventType: "PAYMENT_FAILED", rawType: "payment.failed", occurredAt: "2026-09-01T00:00:00.000Z" }],
    detectedSignals: [{ type: "FAILED_PAYMENT", severity: "HIGH", confidence: 0.9, reason: "failed", rootCause: "GATEWAY_ERROR", estimatedRevenueAtRiskMinor: 250000, ruleId: "r1", ruleVersion: "v1", evidence: {} }],
    scoreComponents: {},
    evidence: {},
    recoveryDecisions: [{ id: "d1", proposedAction: "SEND_PAYMENT_LINK", amountMinor: 250000, confidence: 0.8, diagnosis: "d", rationale: "Send a fresh link.", createdAt: "2026-09-01T00:00:00.000Z" }],
    recoveryActions: [{ id: "a1", type: "SEND_PAYMENT_LINK", status: "PENDING_APPROVAL", amountMinor: 250000, currency: "INR", policyDecision: "REVIEW", policyVersion: 2, idempotencyKey: "k1", externalReference: null, createdAt: "2026-09-01T00:00:00.000Z" }],
    auditHistory: [],
    ...over,
  };
}

test("toApprovalItem extracts the pending action, policy, and Gemini recommendation", () => {
  const item = toApprovalItem(detail({}));
  assert.ok(item);
  assert.equal(item!.actionId, "a1");
  assert.equal(item!.policyDecision, "REVIEW");
  assert.equal(item!.policyVersion, 2);
  assert.equal(item!.customer, "Nadia Khan");
  assert.equal(item!.geminiStrategy, "SEND_PAYMENT_LINK");
  assert.equal(item!.amountMinor, 250000);
});

test("toApprovalItem returns null when no action awaits approval", () => {
  const noPending = detail({ recoveryActions: [{ id: "a1", type: "RETRY_PAYMENT", status: "SUCCEEDED", amountMinor: 1, currency: "INR", policyDecision: "ALLOW", policyVersion: 2, idempotencyKey: "k", externalReference: "ref", createdAt: "2026-09-01T00:00:00.000Z" }] });
  assert.equal(pendingAction(noPending), null);
  assert.equal(toApprovalItem(noPending), null);
});
