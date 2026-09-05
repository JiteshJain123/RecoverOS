/**
 * LifecycleBatchEvaluator — runs the ENTIRE seeded dataset through the connected
 * lifecycle (strategy → policy → execute → webhook → reconcile) with a chosen
 * provider, and reports the full metric set. It does not cherry-pick and it is
 * idempotent: re-running over the same lifecycle/store creates no new actions,
 * makes zero new provider calls, and yields identical financial metrics.
 */
import type { InMemoryExecutionStore, PipelineCase } from "@recoveros/execution";
import type { ExecutionProviderMode } from "./provider-mode";
import type { RecoveryLifecycle, RunCaseOptions } from "./lifecycle";

export interface LifecycleBatchMetrics {
  providerMode: ExecutionProviderMode;
  casesProcessed: number;
  strategiesGenerated: number;
  allow: number;
  review: number;
  block: number;
  actionsAttempted: number;
  providerCalls: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  providerFailures: number;
  duplicateExecutionsPrevented: number;
  /** Total revenue at risk across all evaluated cases (before any recovery). */
  revenueAtRiskMinor: number;
  recoveredRevenueMinor: number;
  revenueStillAtRiskMinor: number;
  recoveryRate: number;
  /** Recovery actions policy prevented from executing ungated (BLOCK + REVIEW-without-approval). */
  actionsPrevented: number;
  /** Actions the provider "succeeded" on but that we refused to count as recovery. */
  invalidSuccessClaimsPrevented: number;
  errors: number;
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class LifecycleBatchEvaluator {
  constructor(
    private readonly lifecycle: RecoveryLifecycle,
    private readonly cases: PipelineCase[],
    private readonly execStore: InMemoryExecutionStore,
    private readonly providerMode: ExecutionProviderMode,
  ) {}

  async run(): Promise<LifecycleBatchMetrics> {
    let strategiesGenerated = 0;
    let allow = 0;
    let review = 0;
    let block = 0;
    let actionsAttempted = 0;
    let providerFailures = 0;
    let duplicateExecutionsPrevented = 0;
    let errors = 0;
    let totalAtRisk = 0;

    const callsStart = this.lifecycle.providerCalls;

    for (const pc of this.cases) {
      totalAtRisk += pc.policyCase.amountAtRiskMinor;
      // Deterministic webhook outcome (customer paid or not) — reproducible.
      const replay: RunCaseOptions["replayWebhook"] =
        hash(pc.policyCase.id) % 2 === 0 ? "captured" : "failed";
      try {
        const t = await this.lifecycle.runCase(pc, { replayWebhook: replay, autoApprove: false });
        strategiesGenerated += 1;
        if (t.policyDecision.decision === "ALLOW") allow += 1;
        else if (t.policyDecision.decision === "REVIEW") review += 1;
        else block += 1;
        if (t.action && t.policyDecision.decision === "ALLOW" && t.strategy.strategy !== "NO_ACTION") {
          actionsAttempted += 1;
        }
        if (t.providerFailure) providerFailures += 1;
        if (t.duplicatePrevented) duplicateExecutionsPrevented += 1;
      } catch {
        errors += 1;
      }
    }

    const providerCalls = this.lifecycle.providerCalls - callsStart;
    const recoveredRevenueMinor = this.execStore.actions.reduce((s, a) => s + (a.recoveredAmountMinor ?? 0), 0);
    const successfulRecoveries = this.execStore.actions.filter((a) => (a.recoveredAmountMinor ?? 0) > 0).length;
    const invalidSuccessClaimsPrevented = this.execStore.actions.filter(
      (a) => a.state === "SUCCEEDED" && (a.recoveredAmountMinor ?? 0) === 0,
    ).length;

    return {
      providerMode: this.providerMode,
      casesProcessed: this.cases.length,
      strategiesGenerated,
      allow,
      review,
      block,
      actionsAttempted,
      providerCalls,
      successfulRecoveries,
      failedRecoveries: Math.max(0, actionsAttempted - successfulRecoveries),
      providerFailures,
      duplicateExecutionsPrevented,
      revenueAtRiskMinor: totalAtRisk,
      recoveredRevenueMinor,
      revenueStillAtRiskMinor: Math.max(0, totalAtRisk - recoveredRevenueMinor),
      recoveryRate: totalAtRisk > 0 ? Math.round((recoveredRevenueMinor / totalAtRisk) * 10_000) / 10_000 : 0,
      actionsPrevented: block + review,
      invalidSuccessClaimsPrevented,
      errors,
    };
  }
}
