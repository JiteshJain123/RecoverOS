/**
 * Persistence port for the Gemini recovery orchestrator.
 *
 * The orchestrator writes AgentRun / AgentToolCall / RecoveryDecision / AuditLog
 * rows around a Gemini call, but depends only on this narrow, tenant-scoped port
 * so it is fully testable without a database. Every method REQUIRES a
 * {@link TenantContext} and MUST scope all access to `ctx.tenantId`; a case that
 * belongs to another tenant reads as "not found" (never leaked).
 *
 * The Prisma adapter lives in ../adapters/prisma-gemini-store.ts.
 */
import type { RecoveryStrategyContext } from "@recoveros/strategy";
import type { CustomerRecoveryHistory } from "./prompt";

export interface TenantContext {
  tenantId: string;
}

/** RecoveryActionType understood by the RecoveryDecision row (Prisma enum). */
export type DecisionActionType =
  | "RETRY_PAYMENT"
  | "SEND_PAYMENT_LINK"
  | "CONTACT_CUSTOMER"
  | "NO_ACTION";

/** AgentRun lifecycle status (mirrors Prisma AgentRunStatus). */
export type AgentRunStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMEOUT"
  | "INVALID_OUTPUT"
  | "FALLBACK";

/** Everything needed to build a Gemini prompt for one case, tenant-scoped. */
export interface CaseRecoveryContext {
  strategyContext: RecoveryStrategyContext;
  customerHistory?: CustomerRecoveryHistory;
  policyConstraints?: Record<string, unknown>;
}

export interface CreateAgentRunInput {
  caseId: string;
  provider: string;
  model: string;
  startedAt: Date;
}

export interface CompleteAgentRunInput {
  status: AgentRunStatus;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Concise error label ONLY (category/message) — never secrets or payloads. */
  error?: string;
  completedAt: Date;
}

export interface RecordToolCallInput {
  agentRunId: string;
  sequence: number;
  name: string;
  /** Structured input metadata — MUST be free of secrets. */
  args: Record<string, unknown>;
  /** Structured output — MUST be free of secrets. */
  result?: Record<string, unknown>;
  isError: boolean;
}

export interface UpsertDecisionInput {
  caseId: string;
  agentRunId: string;
  proposedAction: DecisionActionType;
  amountMinor?: number | null;
  confidence: number;
  diagnosis: string;
  rationale: string;
}

export interface AuditEntryInput {
  actorType: "AGENT";
  action: string;
  entityType: "RecoveryCase";
  entityId: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface GeminiRecoveryStore {
  loadCaseContext(ctx: TenantContext, caseId: string): Promise<CaseRecoveryContext | null>;
  createAgentRun(ctx: TenantContext, input: CreateAgentRunInput): Promise<{ id: string }>;
  completeAgentRun(ctx: TenantContext, agentRunId: string, input: CompleteAgentRunInput): Promise<void>;
  recordToolCall(ctx: TenantContext, input: RecordToolCallInput): Promise<void>;
  upsertDecision(ctx: TenantContext, input: UpsertDecisionInput): Promise<{ id: string }>;
  appendAudit(ctx: TenantContext, entry: AuditEntryInput): Promise<void>;
}
