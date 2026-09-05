/**
 * Runnable batch evaluation of the Recovery Policy Gate + Safe Execution layer.
 *
 *   detection → strategy → policy → simulated execution
 *
 * It runs the full pipeline over a DETERMINISTIC synthetic dataset (the same
 * shape/distribution as the seeded recovery cases) WITHOUT requiring a database,
 * then repeats the run to prove idempotency. Nothing real is executed: the
 * executor drives the SimulatedRecoveryProvider — no Razorpay, no messages, no
 * real money.
 *
 * Usage: `pnpm recovery:batch`
 */
import {
  BatchRecoveryEvaluator,
  InMemoryCaseSource,
  InMemoryExecutionStore,
  RecoveryActionExecutor,
  SimulatedRecoveryProvider,
  buildSyntheticDataset,
  type BatchMetrics,
} from "@recoveros/execution";

const TENANT = "seed_tenant_1";
const CLOCK = { now: () => new Date("2026-09-04T12:00:00.000Z") };

function makeEvaluator() {
  const { cases, execCases } = buildSyntheticDataset(TENANT, 60);
  const store = new InMemoryExecutionStore({ cases: execCases });
  const executor = new RecoveryActionExecutor({
    store,
    provider: new SimulatedRecoveryProvider(),
    clock: CLOCK,
  });
  const evaluator = new BatchRecoveryEvaluator({
    source: new InMemoryCaseSource({ [TENANT]: cases }),
    executor,
    clock: CLOCK,
  });
  return { store, evaluator };
}

function print(label: string, m: BatchMetrics): void {
  console.log(`\n=== ${label} ===`);
  console.log(
    JSON.stringify(
      {
        casesProcessed: m.casesProcessed,
        casesAllowed: m.casesAllowed,
        casesReviewed: m.casesReviewed,
        casesBlocked: m.casesBlocked,
        actionsExecuted: m.actionsExecuted,
        successfulRecoveries: m.successfulRecoveries,
        failedRecoveries: m.failedRecoveries,
        recoveredRevenueMinor: m.recoveredRevenueMinor,
        revenueStillAtRiskMinor: m.revenueStillAtRiskMinor,
        recoveryRate: m.recoveryRate,
        errors: m.errors.length,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  // Run 1 and run 2 use the SAME store, so run 2 exercises the idempotency path.
  const { store, evaluator } = makeEvaluator();
  const first = await evaluator.run({ tenantId: TENANT });
  const actionsAfterFirst = store.actions.length;
  print("BATCH RUN 1", first);

  const second = await evaluator.run({ tenantId: TENANT });
  print("BATCH RUN 2 (idempotency)", second);

  const sameMetrics = JSON.stringify(first) === JSON.stringify(second);
  const noNewActions = store.actions.length === actionsAfterFirst;
  console.log("\n=== IDEMPOTENCY ===");
  console.log(
    JSON.stringify(
      { identicalMetrics: sameMetrics, actionsAfterRun1: actionsAfterFirst, actionsAfterRun2: store.actions.length, noNewActions },
      null,
      2,
    ),
  );

  if (!sameMetrics || !noNewActions) {
    console.error("\nIDEMPOTENCY CHECK FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("\nIDEMPOTENCY CHECK PASSED — re-run created no new actions and identical metrics.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
