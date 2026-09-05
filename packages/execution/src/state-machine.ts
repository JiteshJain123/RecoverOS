/**
 * RecoveryAction lifecycle state machine.
 *
 * Explicit states and the ONLY legal transitions between them. Any transition
 * not in the map is rejected (`InvalidActionTransitionError`) so an action can
 * never, e.g., jump from PROPOSED straight to SUCCEEDED, or execute twice.
 *
 *   PROPOSED ─┬─▶ APPROVAL_REQUIRED ─┬─▶ APPROVED ─▶ EXECUTING ─┬─▶ SUCCEEDED
 *             ├─▶ APPROVED           │                          └─▶ FAILED
 *             ├─▶ CANCELLED          ├─▶ CANCELLED
 *             └─▶ EXPIRED            └─▶ EXPIRED
 *   APPROVED also ─▶ CANCELLED | EXPIRED
 *   SUCCEEDED / FAILED / CANCELLED / EXPIRED are terminal.
 */
import { InvalidActionTransitionError } from "./errors";

export type ActionState =
  | "PROPOSED"
  | "APPROVAL_REQUIRED"
  | "APPROVED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

const TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  PROPOSED: ["APPROVAL_REQUIRED", "APPROVED", "CANCELLED", "EXPIRED"],
  APPROVAL_REQUIRED: ["APPROVED", "CANCELLED", "EXPIRED"],
  APPROVED: ["EXECUTING", "CANCELLED", "EXPIRED"],
  EXECUTING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/** Terminal states have no outgoing transitions. */
export const TERMINAL_STATES: ReadonlySet<ActionState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
]);

export function isTerminal(state: ActionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: ActionState, to: ActionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Assert a transition is legal, throwing {@link InvalidActionTransitionError}. */
export function assertTransition(from: ActionState, to: ActionState): void {
  if (!canTransition(from, to)) throw new InvalidActionTransitionError(from, to);
}
