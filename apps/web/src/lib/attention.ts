/** Pure grouping of cases into the Overview "Needs Attention" buckets. */
import type { CaseListItemDTO } from "./types";

export interface AttentionBuckets {
  highPriority: CaseListItemDTO[];
  pendingApprovals: CaseListItemDTO[];
  failedRecoveries: CaseListItemDTO[];
  policyBlocks: CaseListItemDTO[];
}

const OPEN = new Set(["DETECTED", "ANALYZING", "PROPOSED", "PENDING_APPROVAL", "AUTHORIZED", "EXECUTING"]);

export function groupAttention(cases: CaseListItemDTO[], limit = 5): AttentionBuckets {
  const highPriority = cases
    .filter((c) => OPEN.has(c.status) && (c.priorityScore ?? 0) >= 70)
    .slice(0, limit);
  const pendingApprovals = cases.filter((c) => c.status === "PENDING_APPROVAL").slice(0, limit);
  const failedRecoveries = cases.filter((c) => c.status === "FAILED").slice(0, limit);
  const policyBlocks = cases.filter((c) => c.status === "BLOCKED").slice(0, limit);
  return { highPriority, pendingApprovals, failedRecoveries, policyBlocks };
}
