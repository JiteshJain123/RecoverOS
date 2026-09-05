/**
 * The strategy-provider boundary.
 *
 * A `RecoveryStrategyProvider` turns a recovery case + normalized context into a
 * {@link RecoveryPlan}. It is the seam where a future Gemini implementation
 * plugs in WITHOUT changing any caller: the deterministic provider implemented
 * today and a Gemini-backed provider tomorrow satisfy the same interface and
 * emit the same schema. Crucially, whatever the provider is, its output is only
 * ever a *recommendation* — the policy engine authorizes, never the provider.
 *
 * The interface is async so an implementation may perform I/O (a model call).
 */
import type { CanonicalPaymentStatus, RootCause, Severity } from "@recoveros/intelligence";
import type { RecoveryPlan, Strategy } from "./types";

/** Case lifecycle status (mirrors Prisma `RecoveryCaseStatus`). */
export type RecoveryCaseStatus =
  | "DETECTED"
  | "ANALYZING"
  | "PROPOSED"
  | "PENDING_APPROVAL"
  | "AUTHORIZED"
  | "EXECUTING"
  | "RECOVERED"
  | "FAILED"
  | "BLOCKED"
  | "REJECTED"
  | "EXPIRED";

/**
 * The deterministic pre-check outcome from the policy engine, summarised for the
 * strategy layer. The strategy engine NEVER authorizes; it only uses this to
 * bias its recommendation (e.g. a policy BLOCK forces NO_ACTION; a REVIEW may
 * route a borderline case to a human).
 */
export type PolicyState = "OK" | "REVIEW" | "BLOCKED";

/**
 * A compact, provider-neutral view of a detected signal. Deliberately lighter
 * than the full intelligence `RiskSignal` so this package stays decoupled from
 * detection internals — only what a strategy needs to reason and explain.
 */
export interface StrategySignal {
  type: string;
  severity: Severity;
  rootCause: RootCause;
  confidence: number;
  reason: string;
}

/**
 * Everything a provider needs to choose a strategy for one case. This is the
 * "recovery case plus normalized context" the engine consumes. It contains no
 * secrets and no provider-specific identifiers beyond opaque references.
 */
export interface RecoveryStrategyContext {
  caseId: string;
  tenantId: string;

  caseStatus: RecoveryCaseStatus;
  /** Canonical payment status; `CAPTURED` means the payment already recovered. */
  paymentStatus: CanonicalPaymentStatus | null;
  reason: string;

  rootCause: RootCause | null;
  severity: Severity | null;
  priorityScore: number | null;

  amountAtRiskMinor: number;
  currency: string;

  paymentId: string | null;
  customerId: string | null;

  /** Number of prior failed attempts on this payment (>= 0). */
  retryCount: number;
  /** Whether the customer has a usable contact channel (email/phone). */
  hasContactChannel: boolean;
  /** Whether a payment link expired for this case. */
  hasExpiredLink: boolean;

  /** Deterministic policy pre-check for this case. Defaults to OK. */
  policyState: PolicyState;

  /** Detected signals behind the case, for evidence/explanation. */
  signals: readonly StrategySignal[];

  /**
   * The strategy currently recorded for this case, if any. Supplied by the
   * caller so the service can detect and audit a *strategy change*.
   */
  previousStrategy?: Strategy | null;
}

/** The provider seam. Deterministic today; Gemini-backed later. */
export interface RecoveryStrategyProvider {
  /** Stable identifier for logs/audit (e.g. "deterministic-rules"). */
  readonly name: string;
  /** Produce a (schema-shaped) recommendation for the given case context. */
  generatePlan(ctx: RecoveryStrategyContext): Promise<RecoveryPlan>;
}
