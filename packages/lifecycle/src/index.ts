/**
 * @recoveros/lifecycle
 *
 * Connects the whole recovery lifecycle: payment intelligence → RecoveryCase →
 * strategy (Gemini or deterministic) → PolicyEvaluator → RecoveryAction →
 * execution safeguards → SELECTED provider (SIMULATED or RAZORPAY_TEST) →
 * webhook/outcome reconciliation → recovered revenue → audit trail.
 *
 * Provider selection is server-side only; Gemini can never choose the provider
 * or execute money actions. The simulator remains available for deterministic
 * evaluation.
 */
import {
  DeterministicRecoveryStrategyProvider,
  type RecoveryPlan,
  type RecoveryStrategyContext,
} from "@recoveros/strategy";
import {
  InMemoryExecutionStore,
  SimulatedRecoveryProvider,
  buildSyntheticDataset,
  type Clock,
  type PaymentRecoveryProvider,
  type PipelineCase,
} from "@recoveros/execution";
import { RecoveryLifecycle } from "./lifecycle";
import type { ExecutionProviderMode } from "./provider-mode";

export const DEFAULT_WEBHOOK_SECRET = "whsec_lifecycle_test_secret";
export const DEFAULT_WEBHOOK_ACCOUNT_ID = "acc_test_RECOVEROS1";

// Provider mode
export {
  selectExecutionProvider,
  resolveProviderSelectionFromEnv,
} from "./provider-mode";
export type {
  ExecutionProviderMode,
  ProviderSelectionConfig,
  SelectProviderDeps,
  SelectedProvider,
} from "./provider-mode";

// Accounting
export { isRecoveredOutcome, recoveredAmountFor, RECOVERY_ACCOUNTING_RULES } from "./accounting";

// Failure harness
export {
  makeRazorpayTransport,
  capturedWebhook,
  authorizedWebhook,
  failedWebhook,
} from "./failure-harness";
export type { RazorpayFault, RazorpayScenario, WebhookReplayOptions } from "./failure-harness";

// Reconciler
export { LifecycleCaseReconciler } from "./reconciler";
export type { RecoveredEntry } from "./reconciler";

// Lifecycle
export { RecoveryLifecycle } from "./lifecycle";
export type {
  RecoveryLifecycleDeps,
  RunCaseOptions,
  LifecycleTrace,
  FinalOutcome,
} from "./lifecycle";

// Batch
export { LifecycleBatchEvaluator } from "./batch";
export type { LifecycleBatchMetrics } from "./batch";

// Failure Lab (development-only demonstration + evaluation engine)
export { runFailureScenario, listFailureScenarios, isFailureScenario, runSafetyReport } from "./failure-lab";
export type {
  FailureScenarioMeta,
  FailureScenarioGroup,
  FailureLabRun,
  FailureLabStage,
  FailureLabStats,
  FailureLabPass,
  InvariantResult,
  SafetyResult,
  StageStatus,
  RunFailureScenarioDeps,
  SafetyReport,
  SafetyEvidenceRow,
} from "./failure-lab";

export interface StrategyProviderLike {
  name: string;
  generatePlan(ctx: RecoveryStrategyContext): Promise<RecoveryPlan>;
}

export interface LifecycleBundle {
  lifecycle: RecoveryLifecycle;
  execStore: InMemoryExecutionStore;
  cases: PipelineCase[];
  providerMode: ExecutionProviderMode;
}

/**
 * Build a fully-wired lifecycle over a synthetic dataset for a given provider.
 * `provider` defaults to the deterministic simulator.
 */
export function buildLifecycle(opts: {
  tenantId: string;
  count?: number;
  clock: Clock;
  provider?: PaymentRecoveryProvider;
  providerMode?: ExecutionProviderMode;
  strategyProvider?: StrategyProviderLike;
  webhookSecret?: string;
  webhookAccountId?: string;
  executorConfig?: { executionTtlMs?: number; approvalTtlMs?: number };
}): LifecycleBundle {
  const { cases, execCases } = buildSyntheticDataset(opts.tenantId, opts.count ?? 40, opts.clock.now());
  const execStore = new InMemoryExecutionStore({ cases: execCases });
  const provider = opts.provider ?? new SimulatedRecoveryProvider();
  const providerMode = opts.providerMode ?? "SIMULATED";
  const strategyProvider =
    opts.strategyProvider ?? new DeterministicRecoveryStrategyProvider({ clock: opts.clock });

  const lifecycle = new RecoveryLifecycle({
    tenantId: opts.tenantId,
    execStore,
    provider,
    providerMode,
    strategyProvider,
    clock: opts.clock,
    webhookSecret: opts.webhookSecret ?? DEFAULT_WEBHOOK_SECRET,
    webhookAccountId: opts.webhookAccountId ?? DEFAULT_WEBHOOK_ACCOUNT_ID,
    executorConfig: opts.executorConfig,
  });

  return { lifecycle, execStore, cases, providerMode };
}
