import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PaymentIntelligenceEngine } from "./engine";
import { InMemoryIntelligenceRepository } from "./in-memory-repository";
import { createRazorpayNormalizer } from "../adapters/razorpay";
import { failedPayment, fixedClock, rawPayment } from "../test-support/fixtures";
import type { RawProviderPayment } from "../adapters/razorpay";

function makeEngine(payments: RawProviderPayment[]): {
  engine: PaymentIntelligenceEngine;
  repo: InMemoryIntelligenceRepository;
} {
  const repo = new InMemoryIntelligenceRepository({ payments });
  const engine = new PaymentIntelligenceEngine({
    repo,
    normalizer: createRazorpayNormalizer(),
    clock: fixedClock,
  });
  return { engine, repo };
}

describe("PaymentIntelligenceEngine.scanTenant (idempotency)", () => {
  it("creates one case per at-risk payment", async () => {
    const { engine, repo } = makeEngine([
      failedPayment("bank_timeout", { id: "p1", tenantId: "t1" }),
      failedPayment("insufficient_funds", { id: "p2", tenantId: "t1" }),
      rawPayment({ id: "p3", tenantId: "t1", status: "CAPTURED", failureCode: null }),
    ]);
    const result = await engine.scanTenant({ tenantId: "t1" });
    assert.equal(result.casesCreated, 2);
    assert.equal(result.paymentsAtRisk, 2);
    const cases = await repo.listCases({ tenantId: "t1" });
    assert.equal(cases.length, 2);
  });

  it("is idempotent: re-scanning the same data creates NO duplicates and no churn", async () => {
    const { engine, repo } = makeEngine([
      failedPayment("bank_timeout", { id: "p1", tenantId: "t1" }),
    ]);
    const first = await engine.scanTenant({ tenantId: "t1" });
    assert.equal(first.casesCreated, 1);

    const second = await engine.scanTenant({ tenantId: "t1" });
    assert.equal(second.casesCreated, 0);
    assert.equal(second.casesUpdated, 0);
    assert.equal(second.casesUnchanged, 1);

    const cases = await repo.listCases({ tenantId: "t1" });
    assert.equal(cases.length, 1, "still exactly one case after re-scan");

    // Only the initial creation produced an audit record.
    const created = repo.audits.filter((a) => a.action === "intelligence.case.created");
    assert.equal(created.length, 1);
  });

  it("does not duplicate a case when one already exists for the payment", async () => {
    const payment = failedPayment("gateway_error", { id: "p9", tenantId: "t1" });
    const repo = new InMemoryIntelligenceRepository({
      payments: [payment],
      cases: [
        {
          id: "preexisting_case",
          tenantId: "t1",
          paymentId: "p9",
          customerId: "cust_1",
          reason: "FAILED_PAYMENT",
          status: "DETECTED",
          amountAtRiskMinor: 500_000,
          currency: "INR",
          rootCause: null,
          severity: null,
          priorityScore: null,
          priorityComponents: null,
          riskSignals: null,
          detectionRuleVersion: null,
          lastDetectedAt: null,
          createdByEngine: false,
        },
      ],
    });
    const engine = new PaymentIntelligenceEngine({
      repo,
      normalizer: createRazorpayNormalizer(),
      clock: fixedClock,
    });

    const result = await engine.scanTenant({ tenantId: "t1" });
    assert.equal(result.casesCreated, 0);
    assert.equal(result.casesUpdated, 1, "annotates the pre-existing case instead of duplicating");

    const cases = await repo.listCases({ tenantId: "t1" });
    assert.equal(cases.length, 1);
    assert.equal(cases[0]?.id, "preexisting_case");
    assert.ok(cases[0]?.priorityScore != null, "intelligence annotations applied");
    assert.equal(cases[0]?.rootCause, "GATEWAY_ERROR");
  });

  it("writes an audit record describing what/why/rule on case creation", async () => {
    const { engine, repo } = makeEngine([
      failedPayment("bank_timeout", { id: "p1", tenantId: "t1" }),
    ]);
    await engine.scanTenant({ tenantId: "t1" });
    const audit = repo.audits.find((a) => a.action === "intelligence.case.created");
    assert.ok(audit);
    assert.equal(audit.actorType, "SYSTEM");
    assert.equal(audit.entityType, "RecoveryCase");
    assert.equal(audit.metadata.ruleVersion, "detect-v1");
    assert.equal(audit.metadata.classifier, "TIMEOUT");
    assert.ok(Array.isArray(audit.metadata.signalTypes));
  });
});

describe("PaymentIntelligenceEngine tenant isolation", () => {
  it("never sees or writes another tenant's data", async () => {
    const { engine, repo } = makeEngine([
      failedPayment("bank_timeout", { id: "a1", tenantId: "tenant_a" }),
      failedPayment("bank_timeout", { id: "b1", tenantId: "tenant_b" }),
    ]);

    const a = await engine.scanTenant({ tenantId: "tenant_a" });
    assert.equal(a.scannedPayments, 1);
    assert.equal(a.casesCreated, 1);

    const casesA = await repo.listCases({ tenantId: "tenant_a" });
    const casesB = await repo.listCases({ tenantId: "tenant_b" });
    assert.equal(casesA.length, 1);
    assert.equal(casesB.length, 0, "tenant_b untouched by tenant_a scan");
    assert.ok(repo.audits.every((x) => x.tenantId === "tenant_a"));
  });

  it("detectForTenant only reports the requested tenant's signals", async () => {
    const { engine } = makeEngine([
      failedPayment("bank_timeout", { id: "a1", tenantId: "tenant_a" }),
      failedPayment("bank_timeout", { id: "b1", tenantId: "tenant_b" }),
    ]);
    const report = await engine.detectForTenant({ tenantId: "tenant_b" });
    assert.equal(report.paymentsScanned, 1);
    assert.ok(report.signals.every((s) => s.tenantId === "tenant_b"));
    assert.ok(report.signals.every((s) => s.paymentId === "b1"));
  });

  it("rejects an empty tenant context", async () => {
    const { engine } = makeEngine([]);
    await assert.rejects(() => engine.scanTenant({ tenantId: "" }), /Tenant context is required/);
    await assert.rejects(
      () => engine.detectForTenant({ tenantId: "   " }),
      /Tenant context is required/,
    );
  });
});

describe("PaymentIntelligenceEngine.summarizeTenant", () => {
  it("aggregates revenue at risk once per payment via the primary signal", async () => {
    const { engine } = makeEngine([
      failedPayment("bank_timeout", { id: "p1", tenantId: "t1", amountMinor: 1_000_000 }),
      failedPayment("insufficient_funds", { id: "p2", tenantId: "t1", amountMinor: 500_000 }),
      rawPayment({ id: "p3", tenantId: "t1", status: "CAPTURED", failureCode: null }),
    ]);
    const summary = await engine.summarizeTenant({ tenantId: "t1" });
    assert.equal(summary.paymentsAtRisk, 2);
    // Counted once per payment, not once per signal.
    assert.equal(summary.totalAtRiskMinor, 1_500_000);
    assert.equal(summary.byRootCause.TIMEOUT?.count, 1);
    assert.equal(summary.byRootCause.INSUFFICIENT_FUNDS?.count, 1);
  });
});
