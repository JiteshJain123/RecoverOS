/**
 * Pure mapping from a recovery case status to the execution-lifecycle indicator:
 *   Proposed → Approval Required → Approved → Executing → Provider Outcome →
 *   Verified → Recovered
 * For terminal/failed cases we mark WHERE execution stopped and why.
 */
import type { CaseStatus } from "./types";

export const LIFECYCLE_STEPS = [
  "Proposed",
  "Approval Required",
  "Approved",
  "Executing",
  "Provider Outcome",
  "Verified",
  "Recovered",
] as const;

export type LifecycleStepState = "done" | "current" | "pending" | "stopped";

export interface LifecycleStep {
  label: string;
  state: LifecycleStepState;
}

export interface LifecycleView {
  steps: LifecycleStep[];
  stopReason: string | null;
}

/** How far a status has progressed (index into LIFECYCLE_STEPS), and stop info. */
export function lifecycleFor(status: CaseStatus): LifecycleView {
  // reached = last completed step index; current = the in-flight step index;
  // stoppedAt = a step where a terminal failure halted the flow.
  let reached = -1;
  let current = -1;
  let stoppedAt = -1;
  let stopReason: string | null = null;

  switch (status) {
    case "DETECTED":
    case "ANALYZING":
      current = 0; // working toward a proposal
      break;
    case "PROPOSED":
      reached = 0;
      current = 1;
      break;
    case "PENDING_APPROVAL":
      reached = 1;
      current = 1;
      break;
    case "AUTHORIZED":
      reached = 2;
      current = 3;
      break;
    case "EXECUTING":
      reached = 3;
      current = 3;
      break;
    case "RECOVERED":
      reached = 6;
      break;
    case "FAILED":
      reached = 3;
      stoppedAt = 4; // provider outcome was a failure
      stopReason = "Provider outcome was not a successful capture.";
      break;
    case "BLOCKED":
      reached = 0;
      stoppedAt = 1;
      stopReason = "Policy blocked this action; nothing was executed.";
      break;
    case "REJECTED":
      reached = 1;
      stoppedAt = 1;
      stopReason = "A reviewer rejected this action.";
      break;
    case "EXPIRED":
      reached = 2;
      stoppedAt = 3;
      stopReason = "The action expired before it completed.";
      break;
    default:
      break;
  }

  const steps: LifecycleStep[] = LIFECYCLE_STEPS.map((label, i) => {
    if (stoppedAt === i) return { label, state: "stopped" };
    if (i <= reached) return { label, state: "done" };
    if (i === current) return { label, state: "current" };
    return { label, state: "pending" };
  });

  return { steps, stopReason };
}
