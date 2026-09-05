/**
 * @recoveros/strategy
 *
 * Phase 3 Recovery Strategy Engine. Given a recovery case plus normalized
 * context, it produces a strict, provider-neutral `RecoveryPlan`: the BEST
 * bounded recovery intervention as a *recommendation only*.
 *
 * ARCHITECTURE INVARIANT (Track 3): a strategy provider — deterministic today,
 * Gemini later — may only PROPOSE. It never executes a financial action, never
 * messages a customer, never calls a PSP. Its plan is validated here and handed
 * to the deterministic policy engine, which authorizes; only an approved action
 * can eventually reach a payment-provider adapter.
 *
 * Composition roots:
 *  - `createDeterministicStrategyService()` wires the deterministic provider to
 *    the Prisma audit sink for production use.
 *  - Construct `RecoveryStrategyService` directly with your own provider/sink in
 *    tests (see `InMemoryStrategyAuditSink`).
 */
import { DeterministicRecoveryStrategyProvider } from "./deterministic-provider";
import { PrismaStrategyAuditSink } from "./adapters/prisma-audit-sink";
import { RecoveryStrategyService } from "./service";
import type { Logger } from "@recoveros/observability";

/** Wall-clock. Swap for a fixed clock in tests for determinism. */
export { type Clock } from "./deterministic-provider";

// Schema + validation
export {
  STRATEGIES,
  ACTION_KINDS,
  RISK_LEVELS,
  STOPPING_CONDITION_TYPES,
  EVIDENCE_SOURCES,
  strategySchema,
  actionKindSchema,
  riskLevelSchema,
  stoppingConditionTypeSchema,
  evidenceSourceSchema,
  stoppingConditionSchema,
  evidenceItemSchema,
  expectedOutcomeSchema,
  modelMetadataSchema,
  proposedActionSchema,
  recoveryPlanSchema,
  validateRecoveryPlan,
  assertValidRecoveryPlan,
  RecoveryPlanValidationError,
} from "./types";
export type {
  Strategy,
  ActionKind,
  RiskLevel,
  StoppingConditionType,
  EvidenceSource,
  StoppingCondition,
  EvidenceItem,
  ExpectedOutcome,
  ModelMetadata,
  ProposedRecoveryAction,
  RecoveryPlan,
  PlanValidationIssue,
  ValidateResult,
} from "./types";

// Provider seam
export type {
  RecoveryStrategyProvider,
  RecoveryStrategyContext,
  RecoveryCaseStatus,
  PolicyState,
  StrategySignal,
} from "./provider";
export {
  DeterministicRecoveryStrategyProvider,
  decideStrategy,
  isPolicyState,
} from "./deterministic-provider";
export type { DeterministicProviderDeps } from "./deterministic-provider";

// Idempotency
export { generateIdempotencyKey } from "./idempotency";
export type { IdempotencyInput } from "./idempotency";

// Audit
export {
  InMemoryStrategyAuditSink,
} from "./audit";
export type {
  StrategyAuditSink,
  StrategyAuditEntry,
  AuditTenantContext,
  RecordedStrategyAudit,
} from "./audit";
export { PrismaStrategyAuditSink } from "./adapters/prisma-audit-sink";

// Service
export { RecoveryStrategyService } from "./service";
export type { RecoveryStrategyServiceDeps } from "./service";

// Config (versions / capabilities / thresholds / TTLs)
export {
  STRATEGY_RULES_VERSION,
  CAPABILITY,
  STRATEGY_THRESHOLDS,
  TTL_SECONDS,
} from "./config";
export type { Capability } from "./config";

/**
 * Production composition root: deterministic provider + Prisma-backed audit.
 */
export function createDeterministicStrategyService(options?: {
  logger?: Logger;
}): RecoveryStrategyService {
  return new RecoveryStrategyService({
    provider: new DeterministicRecoveryStrategyProvider(),
    audit: new PrismaStrategyAuditSink(),
    logger: options?.logger,
  });
}
