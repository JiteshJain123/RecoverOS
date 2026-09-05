/**
 * @recoveros/intelligence
 *
 * Phase 2 payment-intelligence engine. Deterministic (NO LLM): it normalizes
 * payment/event data into a provider-agnostic model, classifies root cause,
 * detects revenue-at-risk signals, scores case priority explainably, and
 * idempotently generates recovery candidates with full audit trails.
 *
 * Composition root: use `createPaymentIntelligenceEngine()` to get an engine
 * wired to the Prisma repository + Razorpay normalizer, or construct
 * `PaymentIntelligenceEngine` directly with your own ports (e.g. the in-memory
 * repository in tests).
 */
import { PaymentIntelligenceEngine } from "./engine/engine";
import { BatchProcessor, type BatchProcessorConfig } from "./engine/batch";
import { PrismaIntelligenceRepository } from "./adapters/prisma-repository";
import { PrismaIntelligenceReadRepository } from "./adapters/prisma-read-repository";
import { IntelligenceReadService } from "./read/read-service";
import { createRazorpayNormalizer } from "./adapters/razorpay";
import type { Clock } from "./engine/ports";
import type { Logger } from "@recoveros/observability";

/** Real wall-clock. Swap for a fixed clock in tests for determinism. */
export const systemClock: Clock = { now: () => new Date() };

/**
 * Build the production engine (Prisma repo + Razorpay normalizer + system clock).
 */
export function createPaymentIntelligenceEngine(options?: { logger?: Logger }): PaymentIntelligenceEngine {
  return new PaymentIntelligenceEngine({
    repo: new PrismaIntelligenceRepository(),
    normalizer: createRazorpayNormalizer(),
    clock: systemClock,
    logger: options?.logger,
  });
}

/**
 * Build the production batch processor (Prisma repo + Razorpay normalizer +
 * system clock). Idempotent; safe to run repeatedly.
 */
export function createBatchProcessor(options?: {
  logger?: Logger;
  config?: Partial<BatchProcessorConfig>;
}): BatchProcessor {
  return new BatchProcessor({
    repo: new PrismaIntelligenceRepository(),
    normalizer: createRazorpayNormalizer(),
    clock: systemClock,
    logger: options?.logger,
    config: options?.config,
  });
}

// Engine + service types
export { PaymentIntelligenceEngine } from "./engine/engine";
export type {
  EngineDeps,
  PaymentSignals,
  RiskSummary,
  ScanResult,
  TenantSignalReport,
} from "./engine/engine";

// Batch processor
export { BatchProcessor, DEFAULT_BATCH_CONFIG } from "./engine/batch";
export type {
  BatchError,
  BatchProcessorConfig,
  BatchProcessorDeps,
  BatchRunResult,
  RecommendedNextState,
} from "./engine/batch";

// Read-side (dashboard) service + repository
export { IntelligenceReadService, NotFoundError } from "./read/read-service";
export type { ReadServiceDeps } from "./read/read-service";
export { PrismaIntelligenceReadRepository } from "./adapters/prisma-read-repository";
export { InMemoryReadRepository } from "./test-support/in-memory-read-repository";
export type {
  InMemoryReadSeed,
  MemAction,
  MemAudit,
  MemCase,
  MemCustomer,
  MemDecision,
  MemPayment,
  MemPaymentEvent,
} from "./test-support/in-memory-read-repository";
export {
  HIGH_PRIORITY_THRESHOLD,
  OPEN_STATUSES,
} from "./read/read-repository";
export type {
  CaseDetailCore,
  CaseListPage,
  IntelligenceReadRepository,
  PaymentTimelineCore,
  SummaryAggregates,
} from "./read/read-repository";
export type * from "./read/types";

/** Build the production read service (Prisma read repo + system clock). */
export function createIntelligenceReadService(): IntelligenceReadService {
  return new IntelligenceReadService({
    repo: new PrismaIntelligenceReadRepository(),
    clock: systemClock,
  });
}

// Ports & adapters
export type {
  AuditEntry,
  CaseIntelligencePatch,
  Clock,
  CreateCaseInput,
  IntelligenceRepository,
  StoredRecoveryCase,
  TenantContext,
} from "./engine/ports";
export { PrismaIntelligenceRepository } from "./adapters/prisma-repository";
export { InMemoryIntelligenceRepository } from "./engine/in-memory-repository";
export type { InMemorySeed, RecordedAudit } from "./engine/in-memory-repository";
export { createRazorpayNormalizer } from "./adapters/razorpay";
export type {
  PaymentNormalizer,
  RawProviderPayment,
  RawProviderPaymentEvent,
} from "./adapters/razorpay";

// Pure domain (exported for reuse/testing)
export { classifyRootCause } from "./domain/classify";
export type { RootCauseResult } from "./domain/classify";
export { detectSignals, primarySignal } from "./domain/detect";
export type { DetectContext } from "./domain/detect";
export { computePriority } from "./domain/score";
export type { CustomerHistory, ScoreContext } from "./domain/score";
export * from "./domain/types";

// Config (versions/thresholds/weights)
export {
  CLASSIFIER_VERSION,
  DETECTION_RULES_VERSION,
  SCORING_FORMULA_VERSION,
  SCORE_WEIGHTS,
  SCORE_NORMALIZERS,
  THRESHOLDS,
} from "./config";
