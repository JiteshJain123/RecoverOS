import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BatchProcessor } from "./batch";
import { InMemoryIntelligenceRepository } from "./in-memory-repository";
import { createRazorpayNormalizer } from "../adapters/razorpay";
import { event, failedPayment, fixedClock, hoursBeforeNow, rawPayment } from "../test-support/fixtures";
import type { RawProviderPayment } from "../adapters/razorpay";
import type { StoredRecoveryCase } from "./ports";

function makeProcessor(
  payments: RawProviderPayment[],
  seed: { cases?: StoredRecoveryCase[]; customerHistory?: Record<string, { successfulPayments: number; totalCapturedMinor: number }> } = {},
): { proc: BatchProcessor; repo: InMemoryIntelligenceRepository } {
  const repo = new InMemoryIntelligenceRepository({ payments, cases: seed.cases, customerHistory: seed.customerHistory });
  const proc = new BatchProcessor({
    repo,
    normalizer: createRazorpayNormalizer(),
    clock: fixedClock,
    config: { batchSize: 2, highPriorityThreshold: 60 },
  });
  return { proc, repo };
}

function storedCase(over: Partial<StoredRecoveryCase> & { paymentId: string; tenantId: string; status: string }): StoredRecoveryCase {
  return {
    id: over.id ?? `case_${over.paymentId}`,
    tenantId: over.tenantId,
    paymentId: over.paymentId,
    customerId: over.customerId ?? "cust_1",
    reason: over.reason ?? "FAILED_PAYMENT",
    status: over.status,
    amountAtRiskMinor: over.amountAtRiskMinor ?? 500_000,
    currency: over.currency ?? "INR",
    rootCause: over.rootCause ?? null,
    severity: over.severity ?? null,
    priorityScore: over.priorityScore ?? null,
    priorityComponents: over.priorityComponents ?? null,
    riskSignals: over.riskSignals ?? null,
    detectionRuleVersion: over.detectionRuleVersion ?? null,
    lastDetectedAt: over.lastDetectedAt ?? null,
    createdByEngine: over.createdByEngine ?? false,
  };
}

describe("BatchProcessor — repeated processing (idempotency)", () => {
  it("creates cases on the first run and NONE on the second", async () => {
    const { proc, repo } = makeProcessor([
      failedPayment("bank_timeout", { id: "p1", tenantId: "t1" }),
      failedPayment("insufficient_funds", { id: "p2", tenantId: "t1" }),
      rawPayment({ id: "p3", tenantId: "t1", status: "CAPTURED", failureCode: null }),
    ]);

    const first = await proc.processTenant({ tenantId: "t1" });
    assert.equal(first.casesCreated, 2);
    assert.equal(first.totalPaymentsProcessed, 3);
    assert.ok(first.totalEventsProcessed >= 3);

    const second = await proc.processTenant({ tenantId: "t1" });
    assert.equal(second.casesCreated, 0);
    assert.equal(second.casesUpdated, 0);
    assert.equal(second.casesSkipped, 2, "both live cases unchanged → skipped");

    const cases = await repo.listCases({ tenantId: "t1" });
    assert.equal(cases.length, 2, "no duplicate cases after re-run");
  });
});

describe("BatchProcessor — stopping conditions", () => {
  it("ignores an already-recovered case (no update, counted separately)", async () => {
    const payment = failedPayment("bank_declined", { id: "p1", tenantId: "t1" });
    const { proc, repo } = makeProcessor([payment], {
      cases: [storedCase({ tenantId: "t1", paymentId: "p1", status: "RECOVERED", priorityScore: 42 })],
    });
    const r = await proc.processTenant({ tenantId: "t1" });
    assert.equal(r.casesAlreadyRecovered, 1);
    assert.equal(r.casesCreated, 0);
    assert.equal(r.casesUpdated, 0);
    const c = (await repo.listCases({ tenantId: "t1" }))[0];
    assert.equal(c?.priorityScore, 42, "recovered case left untouched");
  });

  it("does not re-escalate a closed/failed case (retry cap)", async () => {
    const payment = failedPayment("bank_declined", { id: "p1", tenantId: "t1" });
    for (const status of ["FAILED", "REJECTED", "EXPIRED", "BLOCKED", "CANCELLED"]) {
      const { proc } = makeProcessor([payment], {
        cases: [storedCase({ tenantId: "t1", paymentId: "p1", status })],
      });
      const r = await proc.processTenant({ tenantId: "t1" });
      assert.equal(r.casesSkipped, 1, `status ${status} should be skipped`);
      assert.equal(r.casesCreated, 0);
      assert.equal(r.casesUpdated, 0);
    }
  });

  it("refreshes (but does not advance) a case that is in the review workflow", async () => {
    const payment = failedPayment("bank_declined", { id: "p1", tenantId: "t1" });
    const { proc, repo } = makeProcessor([payment], {
      cases: [storedCase({ tenantId: "t1", paymentId: "p1", status: "PENDING_APPROVAL", priorityScore: null })],
    });
    const r = await proc.processTenant({ tenantId: "t1" });
    assert.equal(r.casesUpdated, 1, "annotations refreshed");
    assert.equal(r.casesCreated, 0);
    const c = (await repo.listCases({ tenantId: "t1" }))[0];
    assert.equal(c?.status, "PENDING_APPROVAL", "status must NOT change");
    assert.ok(c?.priorityScore != null);
  });
});

describe("BatchProcessor — detection scenarios", () => {
  it("handles a duplicate event without creating a second case", async () => {
    const created = hoursBeforeNow(3);
    const withDupEvent = rawPayment({
      id: "p1",
      tenantId: "t1",
      status: "FAILED",
      failureCode: "bank_timeout",
      events: [
        event("PAYMENT_CREATED", "payment.created", created),
        event("PAYMENT_FAILED", "payment.failed", hoursBeforeNow(2)),
        event("PAYMENT_FAILED", "payment.failed", hoursBeforeNow(2)), // duplicate delivery
      ],
    });
    const { proc, repo } = makeProcessor([withDupEvent]);
    const r1 = await proc.processTenant({ tenantId: "t1" });
    const r2 = await proc.processTenant({ tenantId: "t1" });
    assert.equal(r1.casesCreated, 1);
    assert.equal(r2.casesCreated, 0);
    assert.equal((await repo.listCases({ tenantId: "t1" })).length, 1);
  });

  it("treats multiple failures for one customer as repeated failure (higher priority)", async () => {
    const many = failedPayment("bank_timeout", { id: "p1", tenantId: "t1", attempts: 3, amountMinor: 800_000 });
    const one = failedPayment("bank_timeout", { id: "p2", tenantId: "t1", attempts: 1, amountMinor: 800_000 });
    const { proc, repo } = makeProcessor([many, one]);
    await proc.processTenant({ tenantId: "t1" });
    const cases = await repo.listCases({ tenantId: "t1" });
    const manyCase = cases.find((c) => c.paymentId === "p1");
    const oneCase = cases.find((c) => c.paymentId === "p2");
    assert.ok(manyCase && oneCase);
    assert.ok(
      (manyCase.priorityScore ?? 0) > (oneCase.priorityScore ?? 0),
      "repeated failure should outrank a single failure",
    );
  });

  it("ranks a high-value failed payment above a low-value one", async () => {
    const { proc, repo } = makeProcessor([
      failedPayment("bank_declined", { id: "hi", tenantId: "t1", amountMinor: 2_000_000 }),
      failedPayment("bank_declined", { id: "lo", tenantId: "t1", amountMinor: 40_000 }),
    ]);
    const r = await proc.processTenant({ tenantId: "t1" });
    assert.equal(r.casesCreated, 2);
    const cases = await repo.listCases({ tenantId: "t1" });
    const hi = cases.find((c) => c.paymentId === "hi");
    const lo = cases.find((c) => c.paymentId === "lo");
    assert.ok((hi?.priorityScore ?? 0) > (lo?.priorityScore ?? 0));
    assert.ok(r.highPriorityCases >= 1, "the high-value case should be high priority");
  });

  it("still opens a case for an unknown failure reason (fallback)", async () => {
    const unknown = rawPayment({
      id: "p1",
      tenantId: "t1",
      status: "FAILED",
      failureCode: "weird_unmapped_code",
      failureReason: "no idea",
    });
    const { proc, repo } = makeProcessor([unknown]);
    const r = await proc.processTenant({ tenantId: "t1" });
    assert.equal(r.casesCreated, 1);
    const c = (await repo.listCases({ tenantId: "t1" }))[0];
    assert.equal(c?.rootCause, "UNKNOWN");
  });
});

describe("BatchProcessor — tenant isolation", () => {
  it("processing tenant A never creates/affects tenant B data", async () => {
    const { proc, repo } = makeProcessor([
      failedPayment("bank_timeout", { id: "a1", tenantId: "tenant_a" }),
      failedPayment("bank_timeout", { id: "b1", tenantId: "tenant_b" }),
    ]);

    const a = await proc.processTenant({ tenantId: "tenant_a" });
    assert.equal(a.totalPaymentsProcessed, 1, "only tenant_a payments seen");
    assert.equal(a.casesCreated, 1);

    assert.equal((await repo.listCases({ tenantId: "tenant_b" })).length, 0, "tenant_b untouched");
    assert.ok(repo.audits.every((x) => x.tenantId === "tenant_a"));

    // Now tenant B: independent, sees only its own payment.
    const b = await proc.processTenant({ tenantId: "tenant_b" });
    assert.equal(b.totalPaymentsProcessed, 1);
    assert.equal(b.casesCreated, 1);
    assert.equal((await repo.listCases({ tenantId: "tenant_a" })).length, 1, "tenant_a still exactly one");
  });

  it("rejects an empty tenant context", async () => {
    const { proc } = makeProcessor([]);
    await assert.rejects(() => proc.processTenant({ tenantId: "" }), /Tenant context is required/);
  });
});

describe("BatchProcessor — errors are surfaced, not hidden", () => {
  it("captures a per-payment failure and continues the batch", async () => {
    const repo = new InMemoryIntelligenceRepository({
      payments: [
        failedPayment("bank_timeout", { id: "ok", tenantId: "t1" }),
        failedPayment("bank_timeout", { id: "boom", tenantId: "t1" }),
      ],
    });
    // Force a failure for payment "boom" during case creation.
    const original = repo.createCase.bind(repo);
    repo.createCase = async (ctx, input) => {
      if (input.paymentId === "boom") throw new Error("simulated write failure");
      return original(ctx, input);
    };
    const proc = new BatchProcessor({
      repo,
      normalizer: createRazorpayNormalizer(),
      clock: fixedClock,
      config: { batchSize: 5, highPriorityThreshold: 60 },
    });

    const r = await proc.processTenant({ tenantId: "t1" });
    assert.equal(r.errorCount, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]?.paymentId, "boom");
    assert.match(r.errors[0]?.message ?? "", /simulated write failure/);
    assert.equal(r.casesCreated, 1, "the healthy payment still produced a case");
  });
});
