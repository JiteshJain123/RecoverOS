/**
 * Typed errors for the safe execution layer. Each carries a stable `code` used
 * in audit records and API error envelopes.
 */
export class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** An attempted RecoveryAction state transition that the machine forbids. */
export class InvalidActionTransitionError extends ExecutionError {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid action transition ${from} → ${to}.`, "invalid_transition");
  }
}

/** The case does not exist within the tenant scope (→ HTTP 404). */
export class ActionNotFoundError extends ExecutionError {
  constructor(public readonly actionId: string) {
    super(`Action ${actionId} not found for tenant.`, "action_not_found");
  }
}

/** A role that is not permitted to approve attempted an approval. */
export class UnauthorizedApprovalError extends ExecutionError {
  constructor(public readonly role: string) {
    super(`Role ${role} is not authorized to approve recovery actions.`, "unauthorized_approval");
  }
}
