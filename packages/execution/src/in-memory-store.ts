/**
 * In-memory ExecutionStore for tests and the runnable batch evaluation. Mirrors
 * the Prisma adapter's tenant scoping: rows seeded under tenant A are invisible
 * to tenant B, and id lookups are `(id, tenantId)`.
 */
import type {
  ActionPatch,
  ActionRecord,
  CreateActionInput,
  ExecAuditEntry,
  ExecCasePatch,
  ExecCaseRecord,
  ExecTenantContext,
  ExecutionStore,
} from "./store";

export interface RecordedExecAudit extends ExecAuditEntry {
  tenantId: string;
  at: string;
}

export class InMemoryExecutionStore implements ExecutionStore {
  readonly actions: ActionRecord[] = [];
  readonly audits: RecordedExecAudit[] = [];
  private readonly cases: ExecCaseRecord[];
  private seq = 0;

  constructor(seed: { cases?: ExecCaseRecord[] } = {}) {
    this.cases = (seed.cases ?? []).map((c) => ({ ...c }));
  }

  async findActionByIdempotencyKey(
    ctx: ExecTenantContext,
    key: string,
  ): Promise<ActionRecord | null> {
    return (
      this.actions.find((a) => a.tenantId === ctx.tenantId && a.idempotencyKey === key) ?? null
    );
  }

  async getAction(ctx: ExecTenantContext, id: string): Promise<ActionRecord | null> {
    return this.actions.find((a) => a.tenantId === ctx.tenantId && a.id === id) ?? null;
  }

  async createAction(ctx: ExecTenantContext, input: CreateActionInput): Promise<ActionRecord> {
    this.seq += 1;
    const rec: ActionRecord = {
      id: `act_${this.seq}`,
      tenantId: ctx.tenantId,
      caseId: input.caseId,
      decisionId: input.decisionId,
      idempotencyKey: input.idempotencyKey,
      actionType: input.actionType,
      amountMinor: input.amountMinor,
      currency: input.currency,
      state: input.state,
      policyDecision: input.policyDecision,
      policyVersion: input.policyVersion,
      riskLevel: input.riskLevel,
      approvedByUserId: null,
      approvedAt: null,
      executedAt: null,
      completedAt: null,
      externalReference: null,
      failureReason: null,
      recoveredAmountMinor: null,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.actions.push(rec);
    return { ...rec };
  }

  async updateAction(ctx: ExecTenantContext, id: string, patch: ActionPatch): Promise<ActionRecord> {
    const rec = this.actions.find((a) => a.tenantId === ctx.tenantId && a.id === id);
    if (!rec) throw new Error(`Action ${id} not found for tenant.`);
    Object.assign(rec, patch);
    return { ...rec };
  }

  async getCase(ctx: ExecTenantContext, caseId: string): Promise<ExecCaseRecord | null> {
    const c = this.cases.find((x) => x.tenantId === ctx.tenantId && x.id === caseId);
    return c ? { ...c } : null;
  }

  async updateCase(ctx: ExecTenantContext, caseId: string, patch: ExecCasePatch): Promise<void> {
    const c = this.cases.find((x) => x.tenantId === ctx.tenantId && x.id === caseId);
    if (!c) throw new Error(`Case ${caseId} not found for tenant.`);
    if (patch.status !== undefined) c.status = patch.status;
    if (patch.resolvedAt !== undefined) c.resolvedAt = patch.resolvedAt;
  }

  async appendAudit(ctx: ExecTenantContext, entry: ExecAuditEntry): Promise<void> {
    this.audits.push({ tenantId: ctx.tenantId, at: new Date().toISOString(), ...entry });
  }
}
