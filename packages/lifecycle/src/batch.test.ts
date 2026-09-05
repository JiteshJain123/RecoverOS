/**
 * Lifecycle batch evaluation over the whole synthetic dataset, and a proof of
 * idempotency: re-running over the same lifecycle/store creates no new actions,
 * makes zero new provider calls, and yields identical financial metrics.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLifecycle } from "./index";
import { LifecycleBatchEvaluator } from "./batch";

const clock = { now: () => new Date("2026-09-04T12:00:00.000Z") };

function makeBatch() {
  const bundle = buildLifecycle({ tenantId: "seed_tenant_1", count: 40, clock, providerMode: "SIMULATED" });
  const evaluator = new LifecycleBatchEvaluator(bundle.lifecycle, bundle.cases, bundle.execStore, bundle.providerMode);
  return { evaluator, execStore: bundle.execStore };
}

describe("LifecycleBatchEvaluator", () => {
  it("reports the full metric set over the whole dataset", async () => {
    const { evaluator } = makeBatch();
    const m = await evaluator.run();
    assert.equal(m.casesProcessed, 40);
    assert.equal(m.strategiesGenerated, 40);
    assert.equal(m.allow + m.review + m.block, 40);
    assert.ok(m.actionsAttempted > 0);
    assert.ok(m.providerCalls > 0);
    assert.ok(m.recoveredRevenueMinor >= 0);
    assert.ok(m.revenueStillAtRiskMinor >= 0);
    // Total at risk is exposed and consistent with recovered + still-at-risk.
    assert.equal(m.revenueAtRiskMinor, m.recoveredRevenueMinor + m.revenueStillAtRiskMinor);
    // Actions prevented = policy BLOCK + REVIEW (neither executes ungated).
    assert.equal(m.actionsPrevented, m.block + m.review);
    assert.ok(m.recoveryRate >= 0 && m.recoveryRate <= 1);
    assert.ok(m.successfulRecoveries <= m.actionsAttempted);
    // Never claim a recovery without proof: link-created-without-payment counted.
    assert.ok(m.invalidSuccessClaimsPrevented >= 0);
    assert.equal(m.errors, 0);
  });

  it("is idempotent: re-run makes no new actions/provider calls, identical revenue", async () => {
    const { evaluator, execStore } = makeBatch();
    const first = await evaluator.run();
    const actionsAfterFirst = execStore.actions.length;
    const recoveredAfterFirst = first.recoveredRevenueMinor;

    const second = await evaluator.run();
    assert.equal(execStore.actions.length, actionsAfterFirst, "no duplicate actions");
    assert.equal(second.recoveredRevenueMinor, recoveredAfterFirst, "identical recovered revenue");
    assert.equal(second.revenueStillAtRiskMinor, first.revenueStillAtRiskMinor);
    assert.equal(second.successfulRecoveries, first.successfulRecoveries);
    assert.equal(second.providerCalls, 0, "zero new provider calls on re-run");
    assert.ok(second.duplicateExecutionsPrevented > 0, "duplicates prevented on re-run");
  });
});
