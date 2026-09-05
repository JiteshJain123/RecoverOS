/**
 * Provider-neutral payment-recovery execution boundary.
 *
 * A `PaymentRecoveryProvider` performs (or simulates) the actual recovery action
 * AFTER the policy engine has authorized it and, where required, a human has
 * approved it. Different PSP adapters (or a simulator) implement the same
 * interface. This phase ships only the simulator — no real money ever moves.
 */
import type { PolicyActionType } from "@recoveros/policy";

/** The concrete outcome the provider reports. */
export type ProviderOutcome =
  | "SUCCEEDED" // charge recovered (retry) or link paid → revenue recovered
  | "FAILED" // attempt failed → no revenue
  | "LINK_CREATED" // a payment link was created (no revenue yet)
  | "LINK_EXPIRED" // a link expired unpaid → no revenue
  | "TIMEOUT"; // provider timed out → no revenue (safe to retry upstream)

export interface RecoveryProviderRequest {
  /** The bounded action to perform. CONTACT_CUSTOMER never moves money. */
  actionType: Exclude<PolicyActionType, "NO_ACTION">;
  /** Idempotency key — guarantees at-most-once execution. */
  idempotencyKey: string;
  amountMinor?: number;
  currency: string;
  /** Deterministic drivers (rootCause, simScenario, caseId). No secrets. */
  metadata: Record<string, unknown>;
}

export interface RecoveryProviderResult {
  outcome: ProviderOutcome;
  /** Non-secret external reference (simulated ids are `sim_…`). */
  externalReference: string;
  /**
   * Revenue actually recovered (minor units). MUST be 0 unless `outcome` is
   * SUCCEEDED — the system never claims recovery without explicit provider
   * confirmation.
   */
  recoveredAmountMinor: number;
  detail: string;
}

export interface PaymentRecoveryProvider {
  readonly name: string;
  execute(req: RecoveryProviderRequest): Promise<RecoveryProviderResult>;
}
