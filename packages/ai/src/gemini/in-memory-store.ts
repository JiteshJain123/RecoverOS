/**
 * In-memory GeminiRecoveryStore for tests. Mirrors the Prisma adapter's
 * tenant-scoping: a case seeded under tenant A is invisible to tenant B, so the
 * orchestrator's isolation can be tested without a database. Records are plain
 * objects so tests can assert AgentRun/AgentToolCall/RecoveryDecision/audit
 * contents (including that no secret ever appears in them).
 */
import type {
  CaseRecoveryContext,
  CompleteAgentRunInput,
  CreateAgentRunInput,
  GeminiRecoveryStore,
  RecordToolCallInput,
  TenantContext,
  UpsertDecisionInput,
  AuditEntryInput,
} from "./store";

type SeededCase = CaseRecoveryContext & { tenantId: string; caseId: string };

export interface RecordedAgentRun {
  id: string;
  tenantId: string;
  caseId: string;
  provider: string;
  model: string;
  status: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface RecordedToolCall {
  tenantId: string;
  agentRunId: string;
  sequence: number;
  name: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  isError: boolean;
}

export interface RecordedDecision {
  id: string;
  tenantId: string;
  caseId: string;
  agentRunId: string;
  proposedAction: string;
  amountMinor?: number | null;
  confidence: number;
  diagnosis: string;
  rationale: string;
}

export interface RecordedAudit extends AuditEntryInput {
  tenantId: string;
}

export class InMemoryGeminiRecoveryStore implements GeminiRecoveryStore {
  readonly runs: RecordedAgentRun[] = [];
  readonly toolCalls: RecordedToolCall[] = [];
  readonly decisions: RecordedDecision[] = [];
  readonly audits: RecordedAudit[] = [];
  private seq = 0;
  private readonly cases: SeededCase[];

  constructor(seed: { cases?: SeededCase[] } = {}) {
    this.cases = seed.cases ?? [];
  }

  async loadCaseContext(ctx: TenantContext, caseId: string): Promise<CaseRecoveryContext | null> {
    const found = this.cases.find((c) => c.tenantId === ctx.tenantId && c.caseId === caseId);
    if (!found) return null;
    const { tenantId: _t, caseId: _c, ...rest } = found;
    void _t;
    void _c;
    return rest;
  }

  async createAgentRun(ctx: TenantContext, input: CreateAgentRunInput): Promise<{ id: string }> {
    this.seq += 1;
    const id = `run_${this.seq}`;
    this.runs.push({
      id,
      tenantId: ctx.tenantId,
      caseId: input.caseId,
      provider: input.provider,
      model: input.model,
      status: "RUNNING",
      startedAt: input.startedAt.toISOString(),
    });
    return { id };
  }

  async completeAgentRun(
    ctx: TenantContext,
    agentRunId: string,
    input: CompleteAgentRunInput,
  ): Promise<void> {
    const run = this.runs.find((r) => r.tenantId === ctx.tenantId && r.id === agentRunId);
    if (!run) throw new Error(`AgentRun ${agentRunId} not found for tenant.`);
    run.status = input.status;
    run.latencyMs = input.latencyMs;
    run.inputTokens = input.inputTokens;
    run.outputTokens = input.outputTokens;
    run.error = input.error;
    run.completedAt = input.completedAt.toISOString();
  }

  async recordToolCall(ctx: TenantContext, input: RecordToolCallInput): Promise<void> {
    this.toolCalls.push({ tenantId: ctx.tenantId, ...input });
  }

  async upsertDecision(ctx: TenantContext, input: UpsertDecisionInput): Promise<{ id: string }> {
    const existing = this.decisions.find(
      (d) => d.tenantId === ctx.tenantId && d.caseId === input.caseId,
    );
    if (existing) {
      Object.assign(existing, input);
      return { id: existing.id };
    }
    this.seq += 1;
    const id = `dec_${this.seq}`;
    this.decisions.push({ id, tenantId: ctx.tenantId, ...input });
    return { id };
  }

  async appendAudit(ctx: TenantContext, entry: AuditEntryInput): Promise<void> {
    this.audits.push({ tenantId: ctx.tenantId, ...entry });
  }
}
