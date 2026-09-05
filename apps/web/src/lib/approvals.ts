/**
 * Pure assembly of an ApprovalItem from a case detail DTO. Keeps the "what needs
 * a human decision" logic in one testable place. Returns null if the case has no
 * action that is actually awaiting approval.
 */
import type { ApprovalItem, CaseDetailDTO, RecoveryActionDTO } from "./types";

/** Action statuses that represent "waiting for a human to approve". */
const AWAITING_STATUSES = new Set(["PENDING_APPROVAL", "AWAITING_APPROVAL", "REVIEW", "PROPOSED"]);

/** The action awaiting approval (explicit status, else a REVIEW-gated action). */
export function pendingAction(detail: CaseDetailDTO): RecoveryActionDTO | null {
  const byStatus = detail.recoveryActions.find((a) => AWAITING_STATUSES.has(a.status.toUpperCase()));
  if (byStatus) return byStatus;
  const review = detail.recoveryActions.find((a) => (a.policyDecision ?? "").toUpperCase() === "REVIEW");
  return review ?? null;
}

export function toApprovalItem(detail: CaseDetailDTO): ApprovalItem | null {
  const action = pendingAction(detail);
  if (!action) return null;
  const decision = detail.recoveryDecisions[0] ?? null;
  return {
    caseId: detail.id,
    actionId: action.id,
    actionType: action.type,
    amountMinor: action.amountMinor ?? detail.amountAtRiskMinor,
    currency: action.currency || detail.currency,
    customer: detail.customer?.name ?? detail.customer?.email ?? null,
    paymentRef: detail.payment?.paymentRef ?? null,
    policyDecision: action.policyDecision,
    policyVersion: action.policyVersion,
    riskLevel: detail.severity,
    rootCause: detail.rootCause,
    geminiStrategy: decision?.proposedAction ?? null,
    geminiRationale: decision ? decision.rationale.slice(0, 240) : null,
    openedAt: detail.openedAt,
  };
}
