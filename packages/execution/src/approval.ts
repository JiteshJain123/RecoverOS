/**
 * Human approval for REVIEW actions.
 *
 * Only privileged roles may approve; a VIEWER (or ANALYST) never can. Approval
 * transitions APPROVAL_REQUIRED → APPROVED, records the approver, and writes a
 * USER-actor audit event. Rejection cancels the action. All access is
 * tenant-scoped via the store.
 */
import type { Logger } from "@recoveros/observability";
import { ActionNotFoundError, UnauthorizedApprovalError } from "./errors";
import { assertTransition } from "./state-machine";
import type { Clock } from "./executor";
import type { ActionRecord, ExecTenantContext, ExecutionStore } from "./store";

/** Tenant roles (mirrors Prisma Role). */
export type Role = "OWNER" | "ADMIN" | "APPROVER" | "ANALYST" | "VIEWER";

/** Roles permitted to approve a recovery action. */
export const APPROVER_ROLES: ReadonlySet<Role> = new Set(["OWNER", "ADMIN", "APPROVER"]);

export function canApprove(role: Role): boolean {
  return APPROVER_ROLES.has(role);
}

export interface Approver {
  userId: string;
  role: Role;
}

export interface ApprovalServiceDeps {
  store: ExecutionStore;
  clock: Clock;
  logger?: Logger;
}

export class ApprovalService {
  private readonly store: ExecutionStore;
  private readonly clock: Clock;
  private readonly logger?: Logger;

  constructor(deps: ApprovalServiceDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.logger = deps.logger;
  }

  /**
   * Approve an APPROVAL_REQUIRED action. Requires an authorized role and an
   * explicit approval. Throws {@link UnauthorizedApprovalError} for a viewer and
   * {@link InvalidActionTransitionError} if the action is not awaiting approval.
   */
  async approve(ctx: ExecTenantContext, actionId: string, approver: Approver): Promise<ActionRecord> {
    const action = await this.store.getAction(ctx, actionId);
    if (!action) throw new ActionNotFoundError(actionId);
    if (!canApprove(approver.role)) throw new UnauthorizedApprovalError(approver.role);

    // Enforced by the state machine: only APPROVAL_REQUIRED → APPROVED.
    assertTransition(action.state, "APPROVED");
    const now = this.clock.now();
    const updated = await this.store.updateAction(ctx, actionId, {
      state: "APPROVED",
      approvedByUserId: approver.userId,
      approvedAt: now,
      updatedAt: now,
    });

    await this.store.appendAudit(ctx, {
      actorType: "USER",
      actorUserId: approver.userId,
      action: "recovery.action.approved",
      entityType: "RecoveryAction",
      entityId: actionId,
      summary: `Approved by ${approver.role} ${approver.userId}.`,
      metadata: {
        role: approver.role,
        decision: action.policyDecision,
        policyVersion: action.policyVersion,
        at: now.toISOString(),
      },
    });
    this.logger?.info("recovery.action.approved", { tenantId: ctx.tenantId, actionId, userId: approver.userId });
    return updated;
  }

  /** Reject an APPROVAL_REQUIRED action (cancels it). */
  async reject(ctx: ExecTenantContext, actionId: string, approver: Approver, reason: string): Promise<ActionRecord> {
    const action = await this.store.getAction(ctx, actionId);
    if (!action) throw new ActionNotFoundError(actionId);
    if (!canApprove(approver.role)) throw new UnauthorizedApprovalError(approver.role);
    assertTransition(action.state, "CANCELLED");
    const now = this.clock.now();
    const updated = await this.store.updateAction(ctx, actionId, {
      state: "CANCELLED",
      failureReason: reason,
      updatedAt: now,
    });
    await this.store.appendAudit(ctx, {
      actorType: "USER",
      actorUserId: approver.userId,
      action: "recovery.action.cancelled",
      entityType: "RecoveryAction",
      entityId: actionId,
      summary: `Rejected by ${approver.role} ${approver.userId}: ${reason}`,
      metadata: { role: approver.role, reason, at: now.toISOString() },
    });
    return updated;
  }
}
