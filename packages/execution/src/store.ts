/**
 * Persistence port for the execution layer. Tenant-scoped: every method takes a
 * {@link ExecTenantContext} and MUST scope access to `ctx.tenantId`. The
 * executor/approval services depend only on this port, so they are testable
 * without a database (see in-memory-store.ts); a Prisma adapter provides the
 * production implementation.
 */
import type { PolicyActionType, PolicyDecisionType } from "@recoveros/policy";
import type { ActionState } from "./state-machine";

export interface ExecTenantContext {
  tenantId: string;
}

/** The persisted recovery-action record the executor reasons over. */
export interface ActionRecord {
  id: string;
  tenantId: string;
  caseId: string;
  decisionId: string | null;
  idempotencyKey: string;
  actionType: PolicyActionType;
  amountMinor: number | null;
  currency: string;
  state: ActionState;
  policyDecision: PolicyDecisionType;
  policyVersion: number | null;
  riskLevel: string;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  executedAt: Date | null;
  completedAt: Date | null;
  externalReference: string | null;
  failureReason: string | null;
  /** Revenue actually recovered by this action (set only on a genuine success). */
  recoveredAmountMinor: number | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateActionInput {
  caseId: string;
  decisionId: string | null;
  idempotencyKey: string;
  actionType: PolicyActionType;
  amountMinor: number | null;
  currency: string;
  state: ActionState;
  policyDecision: PolicyDecisionType;
  policyVersion: number | null;
  riskLevel: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export type ActionPatch = Partial<
  Pick<
    ActionRecord,
    | "state"
    | "approvedByUserId"
    | "approvedAt"
    | "executedAt"
    | "completedAt"
    | "externalReference"
    | "failureReason"
    | "recoveredAmountMinor"
    | "updatedAt"
  >
>;

/** Minimal case view + the fields the executor updates on an outcome. */
export interface ExecCaseRecord {
  id: string;
  tenantId: string;
  status: string;
  amountAtRiskMinor: number;
  currency: string;
  resolvedAt: Date | null;
}

export interface ExecCasePatch {
  status?: string;
  resolvedAt?: Date | null;
}

export interface ExecAuditEntry {
  actorType: "SYSTEM" | "USER" | "POLICY_ENGINE";
  actorUserId?: string | null;
  action: string;
  entityType: "RecoveryAction" | "RecoveryCase";
  entityId: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface ExecutionStore {
  findActionByIdempotencyKey(ctx: ExecTenantContext, key: string): Promise<ActionRecord | null>;
  getAction(ctx: ExecTenantContext, id: string): Promise<ActionRecord | null>;
  createAction(ctx: ExecTenantContext, input: CreateActionInput): Promise<ActionRecord>;
  updateAction(ctx: ExecTenantContext, id: string, patch: ActionPatch): Promise<ActionRecord>;
  getCase(ctx: ExecTenantContext, caseId: string): Promise<ExecCaseRecord | null>;
  updateCase(ctx: ExecTenantContext, caseId: string, patch: ExecCasePatch): Promise<void>;
  appendAudit(ctx: ExecTenantContext, entry: ExecAuditEntry): Promise<void>;
}
