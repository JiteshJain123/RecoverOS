/**
 * SimulatedRecoveryProvider — a deterministic, money-safe stand-in for a real
 * PSP adapter. It NEVER contacts a provider and NEVER moves money; it returns a
 * simulated outcome computed purely from the request (idempotency key + action
 * type + metadata), so evaluation runs are fully reproducible.
 *
 * Outcome selection:
 *  - `metadata.simScenario` (if present) forces the outcome, for precise tests:
 *    "retry_success" | "retry_fail" | "link_created" | "link_expired" | "timeout".
 *  - otherwise it is derived deterministically from the root cause and a stable
 *    hash of the idempotency key, mirroring realistic recovery odds.
 *
 * Revenue is reported ONLY on a genuine SUCCEEDED outcome.
 */
import type {
  PaymentRecoveryProvider,
  ProviderOutcome,
  RecoveryProviderRequest,
  RecoveryProviderResult,
} from "./provider";

/** FNV-1a (32-bit) over a string → unsigned int. Pure, no randomness. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SCENARIO_OUTCOME: Record<string, ProviderOutcome> = {
  retry_success: "SUCCEEDED",
  retry_fail: "FAILED",
  link_created: "LINK_CREATED",
  link_expired: "LINK_EXPIRED",
  timeout: "TIMEOUT",
};

export interface SimulatedProviderOptions {
  /** Optional injected async boundary (kept sync/deterministic by default). */
  name?: string;
}

export class SimulatedRecoveryProvider implements PaymentRecoveryProvider {
  readonly name: string;

  constructor(options: SimulatedProviderOptions = {}) {
    this.name = options.name ?? "simulated";
  }

  async execute(req: RecoveryProviderRequest): Promise<RecoveryProviderResult> {
    const outcome = this.decideOutcome(req);
    const h = hash(req.idempotencyKey);
    const recovered = outcome === "SUCCEEDED" ? (req.amountMinor ?? 0) : 0;
    return {
      outcome,
      externalReference: `sim_${req.actionType.toLowerCase()}_${h.toString(16)}`,
      recoveredAmountMinor: recovered,
      detail: `simulated ${req.actionType} → ${outcome}`,
    };
  }

  private decideOutcome(req: RecoveryProviderRequest): ProviderOutcome {
    const scenario = typeof req.metadata.simScenario === "string" ? req.metadata.simScenario : null;
    if (scenario && SCENARIO_OUTCOME[scenario]) return SCENARIO_OUTCOME[scenario];

    const rootCause = typeof req.metadata.rootCause === "string" ? req.metadata.rootCause : "UNKNOWN";
    const h = hash(req.idempotencyKey);

    if (req.actionType === "RETRY_PAYMENT") {
      if (rootCause === "TIMEOUT" || rootCause === "GATEWAY_ERROR") return "SUCCEEDED";
      if (rootCause === "BANK_DECLINE") return "FAILED";
      if (rootCause === "INSUFFICIENT_FUNDS") return h % 2 === 0 ? "SUCCEEDED" : "FAILED";
      return h % 3 === 0 ? "FAILED" : "SUCCEEDED";
    }

    if (req.actionType === "SEND_PAYMENT_LINK") {
      const m = h % 3;
      if (m === 0) return "LINK_EXPIRED";
      if (m === 1) return "SUCCEEDED"; // customer paid the link
      return "LINK_CREATED";
    }

    // CONTACT_CUSTOMER: a reminder occasionally prompts the customer to pay.
    return h % 2 === 0 ? "SUCCEEDED" : "FAILED";
  }
}
