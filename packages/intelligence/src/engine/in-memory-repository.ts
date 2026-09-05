/**
 * In-memory IntelligenceRepository — used by tests and small demos. It enforces
 * the SAME tenant-isolation invariant as the Prisma adapter: every read/write
 * is filtered by `ctx.tenantId`, so a query with the wrong tenant sees nothing.
 *
 * Deterministic: preserves insertion order and performs no clock/RNG reads.
 */
import type { CustomerHistory } from "../domain/score";
import type { RawProviderPayment } from "../adapters/razorpay";
import type {
  AuditEntry,
  CaseIntelligencePatch,
  CreateCaseInput,
  IntelligenceRepository,
  StoredRecoveryCase,
  TenantContext,
} from "./ports";

export interface InMemorySeed {
  payments?: RawProviderPayment[];
  cases?: StoredRecoveryCase[];
  customerHistory?: Record<string, CustomerHistory>;
}

export interface RecordedAudit extends AuditEntry {
  tenantId: string;
}

export class InMemoryIntelligenceRepository implements IntelligenceRepository {
  private payments: RawProviderPayment[];
  private cases: StoredRecoveryCase[];
  private readonly history: Record<string, CustomerHistory>;
  /** Exposed for assertions in tests. */
  readonly audits: RecordedAudit[] = [];
  private seq = 0;

  constructor(seed: InMemorySeed = {}) {
    this.payments = [...(seed.payments ?? [])];
    this.cases = [...(seed.cases ?? [])];
    this.history = seed.customerHistory ?? {};
  }

  async listRawPayments(ctx: TenantContext): Promise<RawProviderPayment[]> {
    return this.payments.filter((p) => p.tenantId === ctx.tenantId);
  }

  async getCustomerHistory(
    ctx: TenantContext,
    customerId: string | null,
  ): Promise<CustomerHistory> {
    if (!customerId) return { successfulPayments: 0, totalCapturedMinor: 0 };
    // Key by tenant to prevent cross-tenant history bleed.
    return (
      this.history[`${ctx.tenantId}:${customerId}`] ??
      this.history[customerId] ?? { successfulPayments: 0, totalCapturedMinor: 0 }
    );
  }

  async findCaseByPayment(
    ctx: TenantContext,
    paymentId: string,
  ): Promise<StoredRecoveryCase | null> {
    return (
      this.cases.find((c) => c.tenantId === ctx.tenantId && c.paymentId === paymentId) ?? null
    );
  }

  async createCase(ctx: TenantContext, input: CreateCaseInput): Promise<StoredRecoveryCase> {
    // Enforce the (tenant, payment) idempotency contract at the boundary too.
    const existing = await this.findCaseByPayment(ctx, input.paymentId);
    if (existing) {
      throw new Error(
        `Duplicate case for (tenant=${ctx.tenantId}, payment=${input.paymentId}).`,
      );
    }
    this.seq += 1;
    const created: StoredRecoveryCase = {
      id: `mem_case_${ctx.tenantId}_${input.paymentId}_${this.seq}`,
      tenantId: ctx.tenantId,
      paymentId: input.paymentId,
      customerId: input.customerId,
      reason: input.reason,
      status: "DETECTED",
      amountAtRiskMinor: input.amountAtRiskMinor,
      currency: input.currency,
      rootCause: input.rootCause,
      severity: input.severity,
      priorityScore: input.priorityScore,
      priorityComponents: input.priorityComponents,
      riskSignals: input.riskSignals,
      detectionRuleVersion: input.detectionRuleVersion,
      lastDetectedAt: input.detectedAt,
      createdByEngine: true,
    };
    this.cases.push(created);
    return created;
  }

  async updateCaseIntelligence(
    ctx: TenantContext,
    caseId: string,
    patch: CaseIntelligencePatch,
  ): Promise<StoredRecoveryCase> {
    const idx = this.cases.findIndex((c) => c.tenantId === ctx.tenantId && c.id === caseId);
    if (idx === -1) {
      throw new Error(`Case ${caseId} not found for tenant ${ctx.tenantId}.`);
    }
    const current = this.cases[idx] as StoredRecoveryCase;
    const next: StoredRecoveryCase = {
      ...current,
      amountAtRiskMinor: patch.amountAtRiskMinor,
      rootCause: patch.rootCause,
      severity: patch.severity,
      priorityScore: patch.priorityScore,
      priorityComponents: patch.priorityComponents,
      riskSignals: patch.riskSignals,
      detectionRuleVersion: patch.detectionRuleVersion,
      lastDetectedAt: patch.detectedAt,
    };
    this.cases[idx] = next;
    return next;
  }

  async listCases(ctx: TenantContext): Promise<StoredRecoveryCase[]> {
    return this.cases
      .filter((c) => c.tenantId === ctx.tenantId)
      .sort((a, b) => (b.priorityScore ?? -1) - (a.priorityScore ?? -1));
  }

  async appendAudit(ctx: TenantContext, entry: AuditEntry): Promise<void> {
    this.audits.push({ ...entry, tenantId: ctx.tenantId });
  }
}
