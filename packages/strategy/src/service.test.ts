/**
 * Tests for the RecoveryStrategyService: it validates provider output and emits
 * the right append-only audit events (generated / changed / rejected) and never
 * lets a malformed plan through.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RecoveryStrategyService } from "./service";
import { InMemoryStrategyAuditSink } from "./audit";
import { DeterministicRecoveryStrategyProvider, type Clock } from "./deterministic-provider";
import { RecoveryPlanValidationError } from "./types";
import type { RecoveryStrategyContext, RecoveryStrategyProvider } from "./provider";
import type { RootCause, Severity } from "@recoveros/intelligence";

const fixedClock: Clock = { now: () => new Date("2026-09-03T10:00:00.000Z") };

function ctx(over: Partial<RecoveryStrategyContext> = {}): RecoveryStrategyContext {
  return {
    caseId: over.caseId ?? "case_1",
    tenantId: over.tenantId ?? "tenant_a",
    caseStatus: over.caseStatus ?? "DETECTED",
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
    policyState: over.policyState ?? "OK",
    signals: over.signals ?? [],
    previousStrategy: over.previousStrategy,
  };
}

function makeService(provider?: RecoveryStrategyProvider): {
  service: RecoveryStrategyService;
  audit: InMemoryStrategyAuditSink;
} {
  const audit = new InMemoryStrategyAuditSink();
  const service = new RecoveryStrategyService({
    provider: provider ?? new DeterministicRecoveryStrategyProvider({ clock: fixedClock }),
    audit,
  });
  return { service, audit };
}

describe("RecoveryStrategyService — happy path", () => {
  it("returns a validated plan and audits recovery.strategy.generated", async () => {
    const { service, audit } = makeService();
    const plan = await service.generate(ctx({ rootCause: "TIMEOUT" }));
    assert.equal(plan.strategy, "RETRY_PAYMENT");
    const generated = audit.byAction("recovery.strategy.generated");
    assert.equal(generated.length, 1);
    const g = generated[0];
    assert.ok(g);
    assert.equal(g.tenantId, "tenant_a");
    assert.equal(g.entityId, "case_1");
    assert.equal(g.metadata.strategy, "RETRY_PAYMENT");
  });

  it("audits recovery.strategy.changed when the strategy differs from the previous", async () => {
    const { service, audit } = makeService();
    await service.generate(ctx({ rootCause: "TIMEOUT", previousStrategy: "HUMAN_REVIEW" }));
    const changed = audit.byAction("recovery.strategy.changed");
    assert.equal(changed.length, 1);
    const c = changed[0];
    assert.ok(c);
    assert.equal(c.metadata.from, "HUMAN_REVIEW");
    assert.equal(c.metadata.to, "RETRY_PAYMENT");
  });

  it("does NOT audit a change when the strategy is unchanged", async () => {
    const { service, audit } = makeService();
    await service.generate(ctx({ rootCause: "TIMEOUT", previousStrategy: "RETRY_PAYMENT" }));
    assert.equal(audit.byAction("recovery.strategy.changed").length, 0);
    assert.equal(audit.byAction("recovery.strategy.generated").length, 1);
  });
});

describe("RecoveryStrategyService — rejection path", () => {
  // A deliberately broken provider that emits an invalid plan.
  const badProvider: RecoveryStrategyProvider = {
    name: "broken-provider",
    async generatePlan(c) {
      return {
        caseId: c.caseId,
        strategy: "RETRY_PAYMENT",
        rationale: "x",
        confidence: 5, // invalid
        expectedOutcome: { successProbability: 2, description: "x", revenueRecoverableMinor: -1 },
        riskLevel: "LOW",
        proposedActions: [],
        stoppingConditions: [],
        evidence: [],
        modelMetadata: {
          provider: "deterministic",
          strategyEngine: "x",
          version: "x",
          deterministic: true,
        },
        generatedAt: "not-a-date",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    },
  };

  it("rejects an invalid plan, audits recovery.strategy.rejected, and throws", async () => {
    const { service, audit } = makeService(badProvider);
    await assert.rejects(() => service.generate(ctx()), RecoveryPlanValidationError);
    const rejected = audit.byAction("recovery.strategy.rejected");
    assert.equal(rejected.length, 1);
    const r = rejected[0];
    assert.ok(r);
    assert.equal(r.metadata.provider, "broken-provider");
    assert.ok(Array.isArray(r.metadata.issues));
    // No "generated" event must be emitted for a rejected plan.
    assert.equal(audit.byAction("recovery.strategy.generated").length, 0);
  });

  it("requires a tenant context", async () => {
    const { service } = makeService();
    await assert.rejects(() => service.generate(ctx({ tenantId: "" })), /Tenant context is required/);
  });
});
