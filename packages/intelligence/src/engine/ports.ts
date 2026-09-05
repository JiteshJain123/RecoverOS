/**
 * Ports (interfaces) the engine depends on. The engine never imports Prisma or
 * Express directly — it talks to these abstractions, which keeps the domain
 * logic pure and lets tests substitute an in-memory repository.
 *
 * TENANT ISOLATION INVARIANT: every repository method takes a {@link TenantContext}
 * and MUST scope all reads/writes to `ctx.tenantId`. There is deliberately NO
 * method that fetches tenant-owned data by bare id without a tenant context.
 */
import type { CustomerHistory } from "../domain/score";
import type { PriorityScore, RiskSignal, RootCause, Severity } from "../domain/types";
import type { RawProviderPayment } from "../adapters/razorpay";

/** The required tenant scope for every operation. */
export interface TenantContext {
  tenantId: string;
}

/** Injectable clock so detection timestamps are deterministic in tests. */
export interface Clock {
  now(): Date;
}

/** A recovery case as persisted, limited to fields the engine reads/writes. */
export interface StoredRecoveryCase {
  id: string;
  tenantId: string;
  paymentId: string | null;
  customerId: string | null;
  reason: string;
  status: string;
  amountAtRiskMinor: number;
  currency: string;
  rootCause: RootCause | null;
  severity: Severity | null;
  priorityScore: number | null;
  /** Explainability payload (PriorityScore JSON) for the dashboard. */
  priorityComponents: unknown;
  /** Snapshot of the signals behind the case (RiskSignal[] JSON). */
  riskSignals: unknown;
  detectionRuleVersion: string | null;
  lastDetectedAt: Date | null;
  /** True when this case was originally opened by the intelligence engine. */
  createdByEngine: boolean;
}

/** Input for creating a new engine-owned recovery case. */
export interface CreateCaseInput {
  paymentId: string;
  customerId: string | null;
  reason: string;
  amountAtRiskMinor: number;
  currency: string;
  rootCause: RootCause;
  severity: Severity;
  priorityScore: number;
  priorityComponents: PriorityScore;
  riskSignals: RiskSignal[];
  detectionRuleVersion: string;
  detectedAt: Date;
}

/** Intelligence-only annotations applied to an existing case (never clobbers workflow state). */
export interface CaseIntelligencePatch {
  amountAtRiskMinor: number;
  rootCause: RootCause;
  severity: Severity;
  priorityScore: number;
  priorityComponents: PriorityScore;
  riskSignals: RiskSignal[];
  detectionRuleVersion: string;
  detectedAt: Date;
}

/** Append-only audit record written by the engine. */
export interface AuditEntry {
  actorType: "SYSTEM";
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  metadata: Record<string, unknown>;
}

/**
 * Data-access contract for the intelligence engine. Implemented by the Prisma
 * adapter (production) and the in-memory repository (tests/demo).
 */
export interface IntelligenceRepository {
  /** All payments (with events) for the tenant, as raw provider records. */
  listRawPayments(ctx: TenantContext): Promise<RawProviderPayment[]>;
  /** Aggregate purchase history for one of the tenant's customers. */
  getCustomerHistory(ctx: TenantContext, customerId: string | null): Promise<CustomerHistory>;
  /** Find the (at most one) recovery case for a payment, tenant-scoped. */
  findCaseByPayment(ctx: TenantContext, paymentId: string): Promise<StoredRecoveryCase | null>;
  createCase(ctx: TenantContext, input: CreateCaseInput): Promise<StoredRecoveryCase>;
  updateCaseIntelligence(
    ctx: TenantContext,
    caseId: string,
    patch: CaseIntelligencePatch,
  ): Promise<StoredRecoveryCase>;
  listCases(ctx: TenantContext): Promise<StoredRecoveryCase[]>;
  appendAudit(ctx: TenantContext, entry: AuditEntry): Promise<void>;
}
