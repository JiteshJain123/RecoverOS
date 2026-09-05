/**
 * Connected-lifecycle batch evaluation:
 *
 *   detect → strategy → policy → execute (selected provider) → webhook →
 *   reconcile → verify → recovered revenue
 *
 * Runs the ENTIRE deterministic synthetic dataset through the connected
 * lifecycle with the SIMULATED provider (no credentials/network), then repeats
 * the run over the same lifecycle/store to prove idempotency: no new actions, no
 * new provider calls, identical financial metrics.
 *
 * Usage: `pnpm recovery:lifecycle`
 */
import { buildLifecycle, LifecycleBatchEvaluator, type LifecycleBatchMetrics } from "@recoveros/lifecycle";

const clock = { now: () => new Date("2026-09-04T12:00:00.000Z") };

function print(label: string, m: LifecycleBatchMetrics): void {
  console.log(`\n=== ${label} (${m.providerMode}) ===`);
  console.log(JSON.stringify(m, null, 2));
}

async function main(): Promise<void> {
  const bundle = buildLifecycle({ tenantId: "seed_tenant_1", count: 60, clock, providerMode: "SIMULATED" });
  const evaluator = new LifecycleBatchEvaluator(bundle.lifecycle, bundle.cases, bundle.execStore, bundle.providerMode);

  const first = await evaluator.run();
  const actionsAfterFirst = bundle.execStore.actions.length;
  print("LIFECYCLE BATCH RUN 1", first);

  const second = await evaluator.run();
  print("LIFECYCLE BATCH RUN 2 (idempotency)", second);

  const identicalRevenue = first.recoveredRevenueMinor === second.recoveredRevenueMinor;
  const identicalRisk = first.revenueStillAtRiskMinor === second.revenueStillAtRiskMinor;
  const noNewActions = bundle.execStore.actions.length === actionsAfterFirst;
  const noNewProviderCalls = second.providerCalls === 0;

  console.log("\n=== IDEMPOTENCY ===");
  console.log(
    JSON.stringify(
      {
        identicalRecoveredRevenue: identicalRevenue,
        identicalRevenueStillAtRisk: identicalRisk,
        actionsAfterRun1: actionsAfterFirst,
        actionsAfterRun2: bundle.execStore.actions.length,
        noNewActions,
        run2ProviderCalls: second.providerCalls,
        run2DuplicatesPrevented: second.duplicateExecutionsPrevented,
      },
      null,
      2,
    ),
  );

  if (!identicalRevenue || !identicalRisk || !noNewActions || !noNewProviderCalls) {
    console.error("\nIDEMPOTENCY CHECK FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("\nIDEMPOTENCY CHECK PASSED — identical financial metrics, no new actions, zero new provider calls.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
