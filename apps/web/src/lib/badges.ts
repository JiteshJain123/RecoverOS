/** Maps domain enums to a small set of visual badge variants (pure functions). */
import type { CaseStatus, ConfigStatus, PolicyDecision, ProbeStatus, Severity } from "./types";

export type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger" | "muted";

export function caseStatusVariant(status: CaseStatus): BadgeVariant {
  switch (status) {
    case "RECOVERED":
      return "success";
    case "EXECUTING":
    case "AUTHORIZED":
      return "info";
    case "PENDING_APPROVAL":
    case "PROPOSED":
    case "ANALYZING":
      return "warning";
    case "FAILED":
    case "BLOCKED":
    case "REJECTED":
      return "danger";
    case "EXPIRED":
      return "muted";
    case "DETECTED":
    default:
      return "neutral";
  }
}

export function severityVariant(severity: Severity | null): BadgeVariant {
  switch (severity) {
    case "CRITICAL":
      return "danger";
    case "HIGH":
      return "warning";
    case "MEDIUM":
      return "info";
    case "LOW":
      return "neutral";
    default:
      return "muted";
  }
}

export function policyVariant(decision: PolicyDecision | string | null): BadgeVariant {
  switch (decision) {
    case "ALLOW":
      return "success";
    case "REVIEW":
      return "warning";
    case "BLOCK":
      return "danger";
    default:
      return "muted";
  }
}

export function configVariant(status: ConfigStatus | "OK" | "MISSING"): BadgeVariant {
  switch (status) {
    case "OK":
      return "success";
    case "MISSING":
      return "muted";
    case "MISCONFIGURED":
      return "warning";
    case "REJECTED_LIVE":
      return "danger";
    default:
      return "muted";
  }
}

export function probeVariant(status: ProbeStatus): BadgeVariant {
  switch (status) {
    case "OK":
      return "success";
    case "UNREACHABLE":
      return "warning";
    case "FAILED":
      return "danger";
    case "SKIPPED":
    default:
      return "muted";
  }
}

/**
 * Professional, domain-honest label for a case status. Uses the product's
 * operational vocabulary and deliberately never says "Success" — revenue is only
 * ever described as a "Verified Recovery" once a capture is proven.
 */
export function caseStatusLabel(status: CaseStatus): string {
  switch (status) {
    case "DETECTED":
      return "At Risk";
    case "ANALYZING":
      return "Analyzing";
    case "PROPOSED":
      return "Recommended";
    case "PENDING_APPROVAL":
      return "Awaiting Approval";
    case "AUTHORIZED":
      return "Approved";
    case "EXECUTING":
      return "Executing";
    case "RECOVERED":
      return "Verified Recovery";
    case "FAILED":
      return "Recovery Failed";
    case "BLOCKED":
      return "Safely Prevented";
    case "REJECTED":
      return "Rejected";
    case "EXPIRED":
      return "Expired";
    default:
      return status;
  }
}

/** Priority score (0-100) → variant band. */
export function priorityVariant(score: number | null): BadgeVariant {
  if (score === null) return "muted";
  if (score >= 70) return "danger";
  if (score >= 40) return "warning";
  return "neutral";
}
