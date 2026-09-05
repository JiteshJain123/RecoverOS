/**
 * @recoveros/ai
 *
 * AI agent runtime boundary. The RecoverOS AI provider is **Google Gemini**.
 * This package turns a recovery case's normalized context into a strict,
 * schema-validated `RecoveryPlan` recommendation.
 *
 * SECURITY INVARIANTS:
 *  - Gemini is ADVISORY ONLY. It never calls Razorpay, never executes payments,
 *    never sends customer messages, never bypasses policy, never changes tenant
 *    context, and never invents amounts/customers/status. Amounts and identifiers
 *    are filled deterministically from trusted context, not the model.
 *  - This package must NEVER import @recoveros/payments — the agent can only
 *    PROPOSE. Its output is validated here and handed to @recoveros/policy for
 *    authorization; only an approved action may later be executed.
 *  - No Anthropic SDK, no ANTHROPIC_API_KEY. The model comes from GEMINI_MODEL
 *    and the key from GEMINI_API_KEY.
 */
import { loadGeminiConfig, type LoadGeminiConfigOptions } from "./gemini/config";
import { HttpGeminiClient } from "./gemini/client";
import { GeminiRecoveryStrategyProvider } from "./gemini/provider";
import { PrismaGeminiRecoveryStore } from "./adapters/prisma-gemini-store";
import { GeminiRecoveryService } from "./gemini/service";
import type { Logger } from "@recoveros/observability";

// Config
export {
  loadGeminiConfig,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_BASE_URL,
} from "./gemini/config";
export type { GeminiConfig, LoadGeminiConfigOptions } from "./gemini/config";

// Errors
export {
  GeminiError,
  GeminiConfigError,
  GeminiRequestError,
  GeminiTimeoutError,
  GeminiMalformedOutputError,
} from "./gemini/errors";
export type { GeminiErrorCategory } from "./gemini/errors";

// Client
export { HttpGeminiClient } from "./gemini/client";
export type {
  GeminiClient,
  GeminiGenerateRequest,
  GeminiGenerateResponse,
  GeminiUsage,
  ResponseSchema,
} from "./gemini/client";

// Structured output
export { geminiOutputSchema, geminiResponseSchema } from "./gemini/output-schema";
export type { GeminiOutput } from "./gemini/output-schema";

// Prompt
export { buildSystemInstruction, buildUserPrompt } from "./gemini/prompt";
export type { GeminiPromptInput, CustomerRecoveryHistory } from "./gemini/prompt";

// Provider
export {
  GeminiRecoveryStrategyProvider,
  DEFAULT_GEMINI_PROVIDER_CONFIG,
} from "./gemini/provider";
export type {
  GeminiProviderConfig,
  GeminiProviderDeps,
  GeminiRecommendation,
  GeminiCallMeta,
} from "./gemini/provider";

// Store (persistence port) + adapters
export { InMemoryGeminiRecoveryStore } from "./gemini/in-memory-store";
export type {
  RecordedAgentRun,
  RecordedToolCall,
  RecordedDecision,
  RecordedAudit,
} from "./gemini/in-memory-store";
export { PrismaGeminiRecoveryStore } from "./adapters/prisma-gemini-store";
export type {
  GeminiRecoveryStore,
  TenantContext,
  CaseRecoveryContext,
  DecisionActionType,
  AgentRunStatus,
  CreateAgentRunInput,
  CompleteAgentRunInput,
  RecordToolCallInput,
  UpsertDecisionInput,
  AuditEntryInput,
} from "./gemini/store";

// Orchestrator service
export { GeminiRecoveryService, CaseNotFoundError } from "./gemini/service";
export type { GeminiRecoveryServiceDeps, RecommendationResult } from "./gemini/service";

/**
 * Production composition root: HTTP Gemini client (from env) + Prisma store.
 * Throws {@link GeminiConfigError} if GEMINI_API_KEY / GEMINI_MODEL are invalid.
 */
export function createGeminiRecoveryService(options?: {
  logger?: Logger;
  config?: LoadGeminiConfigOptions;
}): GeminiRecoveryService {
  const config = loadGeminiConfig(options?.config);
  const client = new HttpGeminiClient(config);
  const provider = new GeminiRecoveryStrategyProvider({
    client,
    config: { deterministic: config.temperature === 0 },
  });
  return new GeminiRecoveryService({
    provider,
    store: new PrismaGeminiRecoveryStore(),
    logger: options?.logger,
  });
}
