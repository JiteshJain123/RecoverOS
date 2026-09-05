/**
 * @recoveros/execution
 *
 * The Recovery Policy Gate's SAFE EXECUTION layer. It sits strictly downstream
 * of policy authorization:
 *
 *   Gemini/strategy recommendation → RecoveryPlan validation → Policy Engine
 *     → ALLOW / REVIEW / BLOCK → (approval if REVIEW) → execution if authorized
 *     → outcome verification
 *
 * A recommendation can NEVER reach execution without an ALLOW decision (or a
 * human-approved REVIEW). This package never moves real money — it drives a
 * provider-neutral `PaymentRecoveryProvider`; this phase ships only the
 * deterministic `SimulatedRecoveryProvider`.
 */

// State machine
export {
  assertTransition,
  canTransition,
  isTerminal,
  TERMINAL_STATES,
} from "./state-machine";
export type { ActionState } from "./state-machine";

// Errors
export {
  ExecutionError,
  InvalidActionTransitionError,
  ActionNotFoundError,
  UnauthorizedApprovalError,
} from "./errors";

// Provider + simulator
export { SimulatedRecoveryProvider } from "./simulated-provider";
export type { SimulatedProviderOptions } from "./simulated-provider";
export type {
  PaymentRecoveryProvider,
  ProviderOutcome,
  RecoveryProviderRequest,
  RecoveryProviderResult,
} from "./provider";

// Store (port) + in-memory
export { InMemoryExecutionStore } from "./in-memory-store";
export type { RecordedExecAudit } from "./in-memory-store";
export type {
  ExecutionStore,
  ExecTenantContext,
  ActionRecord,
  ActionPatch,
  CreateActionInput,
  ExecCaseRecord,
  ExecCasePatch,
  ExecAuditEntry,
} from "./store";

// Executor
export {
  RecoveryActionExecutor,
  DEFAULT_EXECUTOR_CONFIG,
} from "./executor";
export type {
  Clock,
  ExecutorConfig,
  ExecutorDeps,
  AuthorizeInput,
  AuthorizeResult,
  AuthorizeStatus,
  ExecuteInput,
  ExecuteResult,
  StoppingState,
} from "./executor";

// Approval
export { ApprovalService, APPROVER_ROLES, canApprove } from "./approval";
export type { Approver, ApprovalServiceDeps, Role } from "./approval";

// Batch pipeline
export {
  BatchRecoveryEvaluator,
  InMemoryCaseSource,
} from "./pipeline";
export type {
  BatchMetrics,
  BatchEvaluatorDeps,
  PipelineCase,
  RecoveryCaseSource,
} from "./pipeline";

// Synthetic dataset (runnable batch + tests)
export { buildSyntheticDataset, SYNTHETIC_POLICY } from "./synthetic";
export type { SyntheticDataset } from "./synthetic";

// Prisma adapters (production; dev endpoints)
export { PrismaExecutionStore, PrismaRecoveryCaseSource } from "./adapters/prisma-execution-store";
