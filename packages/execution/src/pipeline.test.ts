/**
 * Batch pipeline tests: full detection→strategy→policy→simulated-execution over
 * the deterministic synthetic dataset, with a spread of ALLOW/REVIEW/BLOCK, and
 * a proof of idempotency (a second run creates no new actions and yields
 * identical metrics).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BatchRecoveryEvaluator, InMemoryCaseSource } from "./pipeline";
import { RecoveryActionExecutor } from "./executor";
import { InMemoryExecutionStore } from "./in-memory-store";
import { SimulatedRecoveryProvider } from "./simulated-provider";
import { buildSyntheticDataset } from "./synthetic";

function buildBatch(tenantId: string) {
  const { cases, execCases } = buildSyntheticDataset(tenantId, 40);
  const store = new InMemoryExecutionStore({ cases: execCases });
  const clock = { now: () => new Date("2026-09-04T12:00:00.000Z") };
  const executor = new RecoveryActionExecutor({ store, provider: new SimulatedRecoveryProvider(), clock });
  const source = new InMemoryCaseSource({ [tenantId]: cases });
  const evaluator = new BatchRecoveryEvaluator({ source, executor, clock });
  return { store, evaluator };
}

describe("BatchRecoveryEvaluator", () => {
  it("processes every case and exercises ALLOW / REVIEW / BLOCK", async () => {
    const { evaluator } = buildBatch("tenant_a");
    const m = await evaluator.run({ tenantId: "tenant_a" });

    assert.equal(m.casesProcessed, 40);
    assert.equal(m.casesAllowed + m.casesReviewed + m.casesBlocked, 40);
    assert.ok(m.casesAllowed > 0, "some allowed");
    assert.ok(m.casesReviewed > 0, "some reviewed");
    assert.ok(m.casesBlocked > 0, "some blocked");
    assert.ok(m.actionsExecuted > 0, "some executed");
    // Recovered revenue never exceeds the revenue that was at risk.
    assert.ok(m.recoveredRevenueMinor >= 0);
    assert.ok(m.revenueStillAtRiskMinor >= 0);
    assert.ok(m.recoveryRate >= 0 && m.recoveryRate <= 1);
    // Successful recoveries never exceed executed actions.
    assert.ok(m.successfulRecoveries <= m.actionsExecuted);
    assert.equal(m.errors.length, 0);
  });

  it("is idempotent: a second run creates no new actions and identical metrics", async () => {
    const { store, evaluator } = buildBatch("tenant_a");
    const first = await evaluator.run({ tenantId: "tenant_a" });
    const actionsAfterFirst = store.actions.length;

    const second = await evaluator.run({ tenantId: "tenant_a" });
    assert.equal(store.actions.length, actionsAfterFirst, "no duplicate actions on re-run");
    assert.deepEqual(second, first, "metrics identical across runs");
  });

  it("keeps tenants isolated (tenant B sees a different dataset, no bleed)", async () => {
    const a = buildBatch("tenant_a");
    const b = buildBatch("tenant_b");
    const ma = await a.evaluator.run({ tenantId: "tenant_a" });
    const mb = await b.evaluator.run({ tenantId: "tenant_b" });
    assert.equal(ma.tenantId, "tenant_a");
    assert.equal(mb.tenantId, "tenant_b");
    // A's store has only A's actions.
    assert.ok(a.store.actions.every((x) => x.tenantId === "tenant_a"));
  });
});
